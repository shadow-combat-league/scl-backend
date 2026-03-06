import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { CacheModuleOptions, CacheOptionsFactory } from '@nestjs/cache-manager'
import { createClient, RedisClientType } from 'redis'
import { Store } from 'cache-manager'

@Injectable()
export class RedisConfig implements CacheOptionsFactory, OnModuleInit, OnModuleDestroy {
  private redisClient: RedisClientType | null = null

  constructor(private configService: ConfigService) {}

  async createCacheOptions(): Promise<CacheModuleOptions> {
    const redisHost = this.configService.get<string>('REDIS_HOST', 'localhost')
    const redisPort = this.configService.get<number>('REDIS_PORT', 6999)
    const redisPassword = this.configService.get<string>('REDIS_PASSWORD')
    const redisDisabled = this.configService.get<string>('REDIS_DISABLED') === 'true'

    // LOCAL DEV ONLY: If REDIS_DISABLED=true, use in-memory cache (single-process only)
    // NEVER set this in production / Kubernetes — Redis is required for multi-pod cache coherence
    if (redisDisabled) {
      console.log('[Redis] ⚠️  REDIS_DISABLED=true — using in-memory cache (local dev only)')
      const memStore = new Map<string, { value: unknown; expiresAt: number | null }>()
      const inMemoryStore: Store = {
        get: async <T>(key: string) => {
          const entry = memStore.get(key)
          if (!entry) return undefined
          if (entry.expiresAt && Date.now() > entry.expiresAt) { memStore.delete(key); return undefined }
          return entry.value as T
        },
        set: async <T>(key: string, value: T, ttl?: number) => {
          memStore.set(key, { value, expiresAt: ttl ? Date.now() + ttl : null })
        },
        del: async (key: string) => { memStore.delete(key) },
        reset: async () => { memStore.clear() },
        keys: async (pattern = '*') => {
          if (pattern === '*') return [...memStore.keys()]
          const re = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$')
          return [...memStore.keys()].filter(k => re.test(k))
        },
        ttl: async (key: string) => {
          const entry = memStore.get(key)
          if (!entry || !entry.expiresAt) return -1
          return Math.max(0, Math.ceil((entry.expiresAt - Date.now()) / 1000))
        },
        mset: async (args: Array<[string, unknown]>, ttl?: number) => {
          for (const [k, v] of args) memStore.set(k, { value: v, expiresAt: ttl ? Date.now() + ttl : null })
        },
        mget: async (...keys: string[]) => keys.map(k => memStore.get(k)?.value),
        mdel: async (...keys: string[]) => { for (const k of keys) memStore.delete(k) },
      }
      return { store: inMemoryStore, ttl: 3600 }
    }

    // CRITICAL: Always use Redis - NO fallback to in-memory cache
    // This is required for Kubernetes multi-pod deployments
    // Using official 'redis' package directly with cache-manager
    console.log(`[Redis] 🔌 Connecting to Redis at ${redisHost}:${redisPort}`)
    
    try {
      // Create Redis client using official 'redis' package
      this.redisClient = createClient({
        socket: {
          host: redisHost,
          port: redisPort,
          connectTimeout: 5000,
          reconnectStrategy: (retries) => {
            if (retries > 10) {
              console.error(`[Redis] ❌ Failed to reconnect after ${retries} attempts`)
              return new Error('Redis connection failed')
            }
            return Math.min(retries * 100, 3000)
          },
        },
        password: redisPassword || undefined,
      })

      // Connect to Redis
      await this.redisClient.connect()
      console.log(`[Redis] ✅ Redis client connected successfully`)

      // Create a Redis store adapter for cache-manager
      // Store interface requires: get, set, del, reset, keys, ttl, mset, mget, mdel
      const redisStore: Store = {
        get: async <T>(key: string) => {
          const value = await this.redisClient!.get(key)
          if (!value) return undefined
          
          const parsed = JSON.parse(value) as T
          
          // Restore Date objects for GameSettings (launchDate, createdAt, updatedAt)
          if (key === 'game:settings' && parsed && typeof parsed === 'object') {
            const settings = parsed as Record<string, unknown>
            if (settings.launchDate && typeof settings.launchDate === 'string') {
              settings.launchDate = new Date(settings.launchDate)
            }
            if (settings.createdAt && typeof settings.createdAt === 'string') {
              settings.createdAt = new Date(settings.createdAt)
            }
            if (settings.updatedAt && typeof settings.updatedAt === 'string') {
              settings.updatedAt = new Date(settings.updatedAt)
            }
          }
          
          return parsed
        },
        set: async <T>(key: string, value: T, ttl?: number) => {
          const serialized = JSON.stringify(value)
          console.log(`[Redis Store] Setting key: ${key}, TTL: ${ttl}ms`)
          if (ttl && ttl > 0) {
            // TTL is in milliseconds, Redis setEx expects seconds
            const ttlSeconds = Math.ceil(ttl / 1000)
            await this.redisClient!.setEx(key, ttlSeconds, serialized)
            console.log(`[Redis Store] ✅ Set key ${key} with TTL ${ttlSeconds}s in Redis`)
          } else {
            await this.redisClient!.set(key, serialized)
            console.log(`[Redis Store] ✅ Set key ${key} (no TTL) in Redis`)
          }
        },
        del: async (key: string) => {
          await this.redisClient!.del(key)
        },
        reset: async () => {
          await this.redisClient!.flushDb()
        },
        keys: async (pattern: string = '*') => {
          return await this.redisClient!.keys(pattern)
        },
        ttl: async (key: string) => {
          return await this.redisClient!.ttl(key)
        },
        mset: async (arguments_: Array<[string, unknown]>, ttl?: number) => {
          const pipeline = this.redisClient!.multi()
          for (const [key, value] of arguments_) {
            const serialized = JSON.stringify(value)
            if (ttl) {
              pipeline.setEx(key, ttl, serialized)
            } else {
              pipeline.set(key, serialized)
            }
          }
          await pipeline.exec()
        },
        mget: async (...keys: string[]) => {
          const values = await this.redisClient!.mGet(keys)
          return values.map(v => v ? JSON.parse(v) : undefined)
        },
        mdel: async (...keys: string[]) => {
          if (keys.length > 0) {
            await this.redisClient!.del(keys)
          }
        },
      }

      // Test Redis connection immediately
      try {
        const testKey = '__redis_init_test__'
        const testValue = 'redis_working'
        await redisStore.set(testKey, testValue, 1)
        const retrieved = await redisStore.get<string>(testKey)
        if (retrieved === testValue) {
          console.log(`[Redis] ✅ Redis connection test passed - cache is working`)
          await redisStore.del(testKey)
        } else {
          throw new Error('Redis test failed - value mismatch')
        }
      } catch (error) {
        console.error(`[Redis] ❌ Redis connection test failed:`, error)
        throw new Error(`Redis connection test failed: ${error.message}`)
      }
      
      return {
        store: redisStore,
        ttl: 3600, // 1 hour default
      }
    } catch (error) {
      console.error(`[Redis] ❌ CRITICAL: Failed to initialize Redis store:`, error)
      console.error(`[Redis] ❌ Application will NOT start without Redis to prevent multi-pod cache issues`)
      throw new Error(`Redis connection failed: ${error.message}. Cannot use in-memory cache in Kubernetes.`)
    }
  }

  async onModuleInit() {
    console.log(`[Redis] ✅ RedisConfig module initialized - Redis store will be used for all caching`)
  }

  async onModuleDestroy() {
    if (this.redisClient) {
      await this.redisClient.quit()
      console.log(`[Redis] ✅ Redis client disconnected`)
    }
  }
}
