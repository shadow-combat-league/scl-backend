import { Injectable } from '@nestjs/common'
import { Inject } from '@nestjs/common'
import { CACHE_MANAGER } from '@nestjs/cache-manager'
import { Cache } from 'cache-manager'
import axios, { AxiosInstance } from 'axios'
import { ConfigService } from '@nestjs/config'
import { TimezoneService } from '../common/timezone.service'

export interface WordPressPost {
  id: number
  title: string
  content: string
  excerpt: string
  date: string
  modified: string
  slug: string
  featuredImage: string | null
  author: string
}

export interface SiteSettings {
  isLive: boolean
  kickUsername: string | null
}

export interface GameSettingsFromWordPress {
  launchDate: Date | null
  gameState: 'ACTIVE' | 'IN_MAINTENANCE' | 'DISABLED' | 'HIDDEN' | null
  weeklyResetEnabled: boolean | null
  weeklyResetDay: number | null // 0-6
  weeklyResetHour: number | null // 0-23
  weeklyResetMinute: number | null // 0-59
  dailyCheckInEnabled: boolean | null
  dailyCheckInLaunchDate: Date | null
}

export interface BaseAppCode {
  id: number
  code: string
  extraPlays: number
  start: Date
  end: Date
  active: boolean
}

@Injectable()
export class WordpressService {
  private readonly wpClient: AxiosInstance

  constructor(
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private configService: ConfigService,
    private timezoneService: TimezoneService,
  ) {
    const wpUrl = this.configService.get<string>('WORDPRESS_URL', 'http://wordpress:80')
    this.wpClient = axios.create({
      baseURL: wpUrl,
      timeout: 3000, // Fail fast — stale Redis fallback kicks in if WordPress is slow/OOMed
    })
  }

  async getPosts(limit = 10, page = 1): Promise<WordPressPost[]> {
    const cacheKey = `wp:posts:${limit}:${page}`
    const cached = await this.cacheManager.get<WordPressPost[]>(cacheKey)
    if (cached) {
      return cached
    }

    try {
      const response = await this.wpClient.get('/wp-json/wp/v2/posts', {
        params: {
          per_page: limit,
          page,
          _embed: true,
        },
      })

      const posts: WordPressPost[] = response.data.map((post: {
        id: number
        title?: { rendered?: string }
        content?: { rendered?: string }
        excerpt?: { rendered?: string }
        date: string
        modified: string
        slug: string
        _embedded?: {
          'wp:featuredmedia'?: Array<{ source_url?: string }>
          author?: Array<{ name?: string }>
        }
      }) => ({
        id: post.id,
        title: post.title?.rendered || '',
        content: post.content?.rendered || '',
        excerpt: post.excerpt?.rendered || '',
        date: post.date,
        modified: post.modified,
        slug: post.slug,
        featuredImage: post._embedded?.['wp:featuredmedia']?.[0]?.source_url || null,
        author: post._embedded?.author?.[0]?.name || '',
      }))

      await this.cacheManager.set(cacheKey, posts, 600 * 1000) // Cache for 10 minutes (600000ms)
      return posts
    } catch (error) {
      console.error('WordPress API error:', error)
      return []
    }
  }

  async getPost(slug: string): Promise<WordPressPost | null> {
    const cacheKey = `wp:post:${slug}`
    const cached = await this.cacheManager.get<WordPressPost>(cacheKey)
    if (cached) {
      return cached
    }

    try {
      const response = await this.wpClient.get(`/wp-json/wp/v2/posts`, {
        params: {
          slug,
          _embed: true,
        },
      })

      if (response.data.length === 0) {
        return null
      }

      const post = response.data[0] as {
        id: number
        title?: { rendered?: string }
        content?: { rendered?: string }
        excerpt?: { rendered?: string }
        date: string
        modified: string
        slug: string
        _embedded?: {
          'wp:featuredmedia'?: Array<{ source_url?: string }>
          author?: Array<{ name?: string }>
        }
      }
      const formatted: WordPressPost = {
        id: post.id,
        title: post.title?.rendered || '',
        content: post.content?.rendered || '',
        excerpt: post.excerpt?.rendered || '',
        date: post.date,
        modified: post.modified,
        slug: post.slug,
        featuredImage: post._embedded?.['wp:featuredmedia']?.[0]?.source_url || null,
        author: post._embedded?.author?.[0]?.name || '',
      }

      await this.cacheManager.set(cacheKey, formatted, 600 * 1000) // Cache for 10 minutes (600000ms)
      return formatted
    } catch (error) {
      console.error('WordPress API error:', error)
      return null
    }
  }

  async getGameRefCodeByCode(code: string): Promise<WordPressPost | null> {
    // Search by slug (case-insensitive)
    const searchSlug = code.toLowerCase()
    const cacheKey = `wp:game_ref_code:${searchSlug}`
    const cached = await this.cacheManager.get<WordPressPost>(cacheKey)
    if (cached) {
      return cached
    }

    try {
      // Search by slug first (exact match, case-insensitive)
      let response = await this.wpClient.get(`/wp-json/wp/v2/game_ref_code`, {
        params: {
          slug: searchSlug,
          _embed: true,
        },
      })

      // If no match by slug, try searching by title
      if (response.data.length === 0) {
        response = await this.wpClient.get(`/wp-json/wp/v2/game_ref_code`, {
          params: {
            search: code,
            _embed: true,
            per_page: 1,
          },
        })
      }

      if (response.data.length === 0) {
        return null
      }

      const post = response.data[0] as {
        id: number
        title?: { rendered?: string }
        content?: { rendered?: string }
        excerpt?: { rendered?: string }
        date: string
        modified: string
        slug: string
        _embedded?: {
          'wp:featuredmedia'?: Array<{ source_url?: string }>
          author?: Array<{ name?: string }>
        }
      }
      const formatted: WordPressPost = {
        id: post.id,
        title: post.title?.rendered || '',
        content: post.content?.rendered || '',
        excerpt: post.excerpt?.rendered || '',
        date: post.date,
        modified: post.modified,
        slug: post.slug,
        featuredImage: post._embedded?.['wp:featuredmedia']?.[0]?.source_url || null,
        author: post._embedded?.author?.[0]?.name || '',
      }

      await this.cacheManager.set(cacheKey, formatted, 600 * 1000) // Cache for 10 minutes (600000ms)
      return formatted
    } catch (error) {
      console.error('WordPress API error (game_ref_code):', error)
      return null
    }
  }

  /**
   * Parse ACF datetime string in WordPress's timezone context
   * ACF returns datetime strings without timezone info, but they're in WordPress's local timezone
   * Uses shared TimezoneService for DRY timezone handling
   */
  private async parseACFDateTime(dateTimeString: string): Promise<Date | null> {
    return this.timezoneService.parseDateTime(dateTimeString)
  }

  async getSiteSettings(): Promise<SiteSettings | null> {
    console.log('[getSiteSettings] Starting site settings fetch...')
    const cacheKey = 'wp:site_settings'
    const cached = await this.cacheManager.get<SiteSettings>(cacheKey)
    if (cached) {
      console.log('[getSiteSettings] Returning cached settings')
      return cached
    }
    console.log('[getSiteSettings] Cache miss, fetching from WordPress...')

    try {
      // Get the scl_site_settings post type (should only be 1 post)
      const settingsResponse = await this.wpClient.get('/wp-json/wp/v2/scl_site_settings', {
        params: {
          per_page: 1,
          _embed: true,
        },
      })

      if (settingsResponse.data.length === 0) {
        return {
          isLive: false,
          kickUsername: null,
        }
      }

      const settingsPost = settingsResponse.data[0] as {
        id: number
        acf?: {
          livestream_live?: boolean | string | number
          kick_username?: string
        }
        meta?: {
          livestream_live?: string[]
          kick_username?: string[]
        }
      }

      // Extract livestream_live and fallback kick_username from site settings
      let isLive = false
      let fallbackKickUsername: string | null = null

      if (settingsPost.acf) {
        const isLiveValue = settingsPost.acf.livestream_live
        isLive = isLiveValue === true || isLiveValue === '1' || isLiveValue === 1 || isLiveValue === 'true'
        fallbackKickUsername = settingsPost.acf.kick_username || null
      } else if (settingsPost.meta) {
        isLive = settingsPost.meta.livestream_live?.[0] === '1' || settingsPost.meta.livestream_live?.[0] === 'true'
        fallbackKickUsername = settingsPost.meta.kick_username?.[0] || null
      }

      // If ACF not exposed, try fetching ACF fields directly via ACF REST API
      if (!settingsPost.acf && !settingsPost.meta) {
        try {
          const acfResponse = await this.wpClient.get(`/wp-json/acf/v3/scl_site_settings/${settingsPost.id}`)
          if (acfResponse.data && acfResponse.data.acf) {
            const isLiveValue = acfResponse.data.acf.livestream_live
            isLive = isLiveValue === true || isLiveValue === '1' || isLiveValue === 1 || isLiveValue === 'true'
            fallbackKickUsername = acfResponse.data.acf.kick_username || null
          }
        } catch (acfError) {
          // ACF REST API might not be available, that's okay
          console.warn('ACF REST API not available, using defaults')
        }
      }

      // If livestream_live is true, check for active livestreams
      let kickUsername: string | null = fallbackKickUsername

      console.log(`[getSiteSettings] isLive: ${isLive}, fallbackKickUsername: ${fallbackKickUsername}`)

      if (isLive) {
        console.log('[getSiteSettings] isLive is true, checking for active livestreams...')
        try {
          // Get all livestreams post type
          console.log('[getSiteSettings] Fetching livestreams from WordPress API...')
          const livestreamsResponse = await this.wpClient.get('/wp-json/wp/v2/livestreams', {
            params: {
              per_page: 100, // Get enough to check all active streams
              _embed: true,
            },
          })

          console.log(`[getSiteSettings] Received ${livestreamsResponse.data?.length || 0} livestream post(s) from WordPress`)

          const now = new Date()
          const currentTime = now.getTime()
          console.log(`[getSiteSettings] Current UTC time: ${now.toISOString()}`)

          // Find the first livestream that is currently active (between start and end)
          for (const livestream of livestreamsResponse.data) {
            const livestreamPost = livestream as {
              id: number
              acf?: {
                start?: string
                end?: string
                kick_username?: string
              }
              meta?: {
                start?: string[]
                end?: string[]
                kick_username?: string[]
              }
            }

            let startDate: Date | null = null
            let endDate: Date | null = null
            let livestreamKickUsername: string | null = null

            console.log(`[Livestream Check] Processing post ID: ${livestreamPost.id}`)

            if (livestreamPost.acf) {
              console.log(`[Livestream Check] Post ID ${livestreamPost.id} - Using ACF fields`)
              console.log(`  ACF data:`, JSON.stringify(livestreamPost.acf, null, 2))
              if (livestreamPost.acf.start) {
                startDate = await this.parseACFDateTime(livestreamPost.acf.start)
              }
              if (livestreamPost.acf.end) {
                endDate = await this.parseACFDateTime(livestreamPost.acf.end)
              }
              livestreamKickUsername = livestreamPost.acf.kick_username || null
            } else if (livestreamPost.meta) {
              console.log(`[Livestream Check] Post ID ${livestreamPost.id} - Using meta fields`)
              console.log(`  Meta data:`, JSON.stringify(livestreamPost.meta, null, 2))
              if (livestreamPost.meta.start?.[0]) {
                startDate = await this.parseACFDateTime(livestreamPost.meta.start[0])
              }
              if (livestreamPost.meta.end?.[0]) {
                endDate = await this.parseACFDateTime(livestreamPost.meta.end[0])
              }
              livestreamKickUsername = livestreamPost.meta.kick_username?.[0] || null
            }

            // If ACF not exposed, try ACF REST API
            if (!livestreamPost.acf && !livestreamPost.meta) {
              try {
                const acfResponse = await this.wpClient.get(`/wp-json/acf/v3/livestreams/${livestreamPost.id}`)
                if (acfResponse.data && acfResponse.data.acf) {
                  if (acfResponse.data.acf.start) {
                    startDate = await this.parseACFDateTime(acfResponse.data.acf.start)
                  }
                  if (acfResponse.data.acf.end) {
                    endDate = await this.parseACFDateTime(acfResponse.data.acf.end)
                  }
                  livestreamKickUsername = acfResponse.data.acf.kick_username || null
                }
              } catch (acfError) {
                // Continue to next livestream
              }
            }

            // Check if current time is between start and end
            if (startDate && endDate) {
              const startTime = startDate.getTime()
              const endTime = endDate.getTime()

              console.log(`[Livestream Check] Post ID: ${livestreamPost.id}`)
              console.log(`  Start (raw): ${livestreamPost.acf?.start || livestreamPost.meta?.start?.[0]}`)
              console.log(`  End (raw): ${livestreamPost.acf?.end || livestreamPost.meta?.end?.[0]}`)
              console.log(`  Start (parsed UTC): ${startDate.toISOString()}`)
              console.log(`  End (parsed UTC): ${endDate.toISOString()}`)
              console.log(`  Current (UTC): ${new Date(currentTime).toISOString()}`)
              console.log(`  Comparison: ${currentTime} >= ${startTime} && ${currentTime} <= ${endTime}`)
              console.log(`  Result: ${currentTime >= startTime && currentTime <= endTime}`)

              if (currentTime >= startTime && currentTime <= endTime) {
                // Found an active livestream
                console.log(`  ✓ Livestream is ACTIVE! Using kick_username: ${livestreamKickUsername}`)
                if (livestreamKickUsername) {
                  kickUsername = livestreamKickUsername
                }
                break // Use the first active livestream found
              } else {
                console.log(`  ✗ Livestream is NOT active (outside time range)`)
              }
            } else if (startDate && !endDate) {
              // If only start date is set, consider it active if current time is after start
              const startTime = startDate.getTime()
              console.log(`[Livestream Check] Post ID: ${livestreamPost.id} (no end time)`)
              console.log(`  Start (parsed UTC): ${startDate.toISOString()}`)
              console.log(`  Current (UTC): ${new Date(currentTime).toISOString()}`)
              console.log(`  Comparison: ${currentTime} >= ${startTime}`)
              if (currentTime >= startTime) {
                console.log(`  ✓ Livestream is ACTIVE! (started, no end time)`)
                if (livestreamKickUsername) {
                  kickUsername = livestreamKickUsername
                }
                break
              } else {
                console.log(`  ✗ Livestream has not started yet`)
              }
            } else {
              console.log(`[Livestream Check] Post ID: ${livestreamPost.id} - Missing start/end dates`)
            }
          }
          } catch (livestreamsError) {
          console.error('[getSiteSettings] Error fetching livestreams:', livestreamsError)
          if (livestreamsError instanceof Error) {
            console.error('[getSiteSettings] Error message:', livestreamsError.message)
            console.error('[getSiteSettings] Error stack:', livestreamsError.stack)
          }
          // Continue with fallback username
        }
      }

      const settings: SiteSettings = {
        isLive,
        kickUsername,
      }

      await this.cacheManager.set(cacheKey, settings, 60 * 1000) // Cache for 60 seconds (60000ms)
      return settings
    } catch (error) {
      console.error('WordPress API error (site_settings):', error)
      return {
        isLive: false,
        kickUsername: null,
      }
    }
  }

  /**
   * Fetch game settings from WordPress ACF fields
   * Looks for game settings in scl_site_settings post type (same as livestream settings)
   */
  async getGameSettings(): Promise<GameSettingsFromWordPress | null> {
    console.log('[getGameSettings] Starting game settings fetch from WordPress...')
    const cacheKey = 'wp:game_settings'
    const cached = await this.cacheManager.get<GameSettingsFromWordPress>(cacheKey)
    if (cached) {
      console.log('[getGameSettings] Returning cached settings')
      return cached
    }
    console.log('[getGameSettings] Cache miss, fetching from WordPress...')

    try {
      // Get the scl_site_settings post type (should only be 1 post)
      const settingsResponse = await this.wpClient.get('/wp-json/wp/v2/scl_site_settings', {
        params: {
          per_page: 1,
          _embed: true,
        },
      })

      if (settingsResponse.data.length === 0) {
        console.log('[getGameSettings] No scl_site_settings post found')
        return null
      }

      const settingsPost = settingsResponse.data[0] as {
        id: number
        acf?: {
          game_launch_date?: string
          game_state?: string
          weekly_reset_enabled?: boolean | string | number
          weekly_reset_day?: number | string
          weekly_reset_hour?: number | string
          weekly_reset_minute?: number | string
          daily_check_in_enabled?: boolean | string | number
          daily_check_in_launch_date?: string
        }
        meta?: {
          game_launch_date?: string[]
          game_state?: string[]
          weekly_reset_enabled?: string[]
          weekly_reset_day?: string[]
          weekly_reset_hour?: string[]
          weekly_reset_minute?: string[]
          daily_check_in_enabled?: string[]
          daily_check_in_launch_date?: string[]
        }
      }

      console.log(`[getGameSettings] Processing post ID: ${settingsPost.id}`)
      console.log(`[getGameSettings] ACF data:`, JSON.stringify(settingsPost.acf, null, 2))

      let gameSettings: GameSettingsFromWordPress = {
        launchDate: null,
        gameState: null,
        weeklyResetEnabled: null,
        weeklyResetDay: null,
        weeklyResetHour: null,
        weeklyResetMinute: null,
        dailyCheckInEnabled: null,
        dailyCheckInLaunchDate: null,
      }

      if (settingsPost.acf) {
        console.log(`[getGameSettings] Using ACF fields`)
        
        // Parse launch date
        if (settingsPost.acf.game_launch_date) {
          gameSettings.launchDate = await this.parseACFDateTime(settingsPost.acf.game_launch_date)
          console.log(`[getGameSettings] Parsed launch_date: ${settingsPost.acf.game_launch_date} → ${gameSettings.launchDate?.toISOString()}`)
        }

        // Parse game state (handle format like "ACTIVE: Active" or just "ACTIVE")
        if (settingsPost.acf.game_state) {
          const state = settingsPost.acf.game_state.toUpperCase()
          // Extract the state value before colon if present (e.g., "ACTIVE: Active" -> "ACTIVE")
          const stateValue = state.split(':')[0].trim()
          if (['ACTIVE', 'IN_MAINTENANCE', 'DISABLED', 'HIDDEN'].includes(stateValue)) {
            gameSettings.gameState = stateValue as 'ACTIVE' | 'IN_MAINTENANCE' | 'DISABLED' | 'HIDDEN'
          }
        }

        // Parse weekly reset enabled
        if (settingsPost.acf.weekly_reset_enabled !== undefined && settingsPost.acf.weekly_reset_enabled !== null) {
          const value = settingsPost.acf.weekly_reset_enabled
          gameSettings.weeklyResetEnabled = value === true || value === '1' || value === 1 || value === 'true'
        }

        // Parse weekly reset day (handle format like "0: Sunday" or just "0")
        if (settingsPost.acf.weekly_reset_day !== undefined && settingsPost.acf.weekly_reset_day !== null) {
          let day: number
          if (typeof settingsPost.acf.weekly_reset_day === 'string') {
            // Extract number before colon if present (e.g., "0: Sunday" -> "0")
            const dayStr = settingsPost.acf.weekly_reset_day.split(':')[0].trim()
            day = parseInt(dayStr, 10)
          } else {
            day = settingsPost.acf.weekly_reset_day
          }
          if (!isNaN(day) && day >= 0 && day <= 6) {
            gameSettings.weeklyResetDay = day
          }
        }

        // Parse weekly reset hour
        if (settingsPost.acf.weekly_reset_hour !== undefined && settingsPost.acf.weekly_reset_hour !== null) {
          const hour = typeof settingsPost.acf.weekly_reset_hour === 'string' 
            ? parseInt(settingsPost.acf.weekly_reset_hour, 10) 
            : settingsPost.acf.weekly_reset_hour
          if (!isNaN(hour) && hour >= 0 && hour <= 23) {
            gameSettings.weeklyResetHour = hour
          }
        }

        // Parse weekly reset minute
        if (settingsPost.acf.weekly_reset_minute !== undefined && settingsPost.acf.weekly_reset_minute !== null) {
          const minute = typeof settingsPost.acf.weekly_reset_minute === 'string' 
            ? parseInt(settingsPost.acf.weekly_reset_minute, 10) 
            : settingsPost.acf.weekly_reset_minute
          if (!isNaN(minute) && minute >= 0 && minute <= 59) {
            gameSettings.weeklyResetMinute = minute
          }
        }

        // Parse daily check-in enabled
        if (settingsPost.acf.daily_check_in_enabled !== undefined && settingsPost.acf.daily_check_in_enabled !== null) {
          const value = settingsPost.acf.daily_check_in_enabled
          gameSettings.dailyCheckInEnabled = value === true || value === '1' || value === 1 || value === 'true'
        }

        // Parse daily check-in launch date
        if (settingsPost.acf.daily_check_in_launch_date) {
          gameSettings.dailyCheckInLaunchDate = await this.parseACFDateTime(settingsPost.acf.daily_check_in_launch_date)
          console.log(`[getGameSettings] Parsed daily_check_in_launch_date: ${settingsPost.acf.daily_check_in_launch_date} → ${gameSettings.dailyCheckInLaunchDate?.toISOString()}`)
        }
      } else if (settingsPost.meta) {
        console.log(`[getGameSettings] Using meta fields`)
        
        // Parse from meta fields (fallback)
        if (settingsPost.meta.game_launch_date?.[0]) {
          gameSettings.launchDate = await this.parseACFDateTime(settingsPost.meta.game_launch_date[0])
        }
        if (settingsPost.meta.game_state?.[0]) {
          const state = settingsPost.meta.game_state[0].toUpperCase()
          if (['ACTIVE', 'IN_MAINTENANCE', 'DISABLED', 'HIDDEN'].includes(state)) {
            gameSettings.gameState = state as 'ACTIVE' | 'IN_MAINTENANCE' | 'DISABLED' | 'HIDDEN'
          }
        }
        if (settingsPost.meta.weekly_reset_enabled?.[0]) {
          gameSettings.weeklyResetEnabled = settingsPost.meta.weekly_reset_enabled[0] === '1' || settingsPost.meta.weekly_reset_enabled[0] === 'true'
        }
        if (settingsPost.meta.weekly_reset_day?.[0]) {
          const day = parseInt(settingsPost.meta.weekly_reset_day[0], 10)
          if (!isNaN(day) && day >= 0 && day <= 6) {
            gameSettings.weeklyResetDay = day
          }
        }
        if (settingsPost.meta.weekly_reset_hour?.[0]) {
          const hour = parseInt(settingsPost.meta.weekly_reset_hour[0], 10)
          if (!isNaN(hour) && hour >= 0 && hour <= 23) {
            gameSettings.weeklyResetHour = hour
          }
        }
        if (settingsPost.meta.weekly_reset_minute?.[0]) {
          const minute = parseInt(settingsPost.meta.weekly_reset_minute[0], 10)
          if (!isNaN(minute) && minute >= 0 && minute <= 59) {
            gameSettings.weeklyResetMinute = minute
          }
        }
        if (settingsPost.meta.daily_check_in_enabled?.[0]) {
          const value = settingsPost.meta.daily_check_in_enabled[0]
          gameSettings.dailyCheckInEnabled = value === '1' || value === 'true'
        }
        if (settingsPost.meta.daily_check_in_launch_date?.[0]) {
          gameSettings.dailyCheckInLaunchDate = await this.parseACFDateTime(settingsPost.meta.daily_check_in_launch_date[0])
        }
      }

      // If ACF not exposed OR if critical fields are missing, try ACF REST API
      if ((!settingsPost.acf && !settingsPost.meta) || !gameSettings.launchDate) {
        console.log(`[getGameSettings] ACF not exposed or launchDate missing, trying ACF REST API...`)
        try {
          const acfResponse = await this.wpClient.get(`/wp-json/acf/v3/scl_site_settings/${settingsPost.id}`)
          if (acfResponse.data && acfResponse.data.acf) {
            console.log(`[getGameSettings] ACF REST API data:`, JSON.stringify(acfResponse.data.acf, null, 2))
            
            // Only override if we got a value from ACF REST API
            if (acfResponse.data.acf.game_launch_date && !gameSettings.launchDate) {
              gameSettings.launchDate = await this.parseACFDateTime(acfResponse.data.acf.game_launch_date)
              console.log(`[getGameSettings] Got launch_date from ACF REST API: ${acfResponse.data.acf.game_launch_date} → ${gameSettings.launchDate?.toISOString()}`)
            }
            if (acfResponse.data.acf.game_state) {
              const state = acfResponse.data.acf.game_state.toUpperCase()
              if (['ACTIVE', 'IN_MAINTENANCE', 'DISABLED', 'HIDDEN'].includes(state)) {
                gameSettings.gameState = state as 'ACTIVE' | 'IN_MAINTENANCE' | 'DISABLED' | 'HIDDEN'
              }
            }
            if (acfResponse.data.acf.weekly_reset_enabled !== undefined) {
              const value = acfResponse.data.acf.weekly_reset_enabled
              gameSettings.weeklyResetEnabled = value === true || value === '1' || value === 1 || value === 'true'
            }
            if (acfResponse.data.acf.weekly_reset_day !== undefined) {
              const day = typeof acfResponse.data.acf.weekly_reset_day === 'string' 
                ? parseInt(acfResponse.data.acf.weekly_reset_day, 10) 
                : acfResponse.data.acf.weekly_reset_day
              if (!isNaN(day) && day >= 0 && day <= 6) {
                gameSettings.weeklyResetDay = day
              }
            }
            if (acfResponse.data.acf.weekly_reset_hour !== undefined) {
              const hour = typeof acfResponse.data.acf.weekly_reset_hour === 'string' 
                ? parseInt(acfResponse.data.acf.weekly_reset_hour, 10) 
                : acfResponse.data.acf.weekly_reset_hour
              if (!isNaN(hour) && hour >= 0 && hour <= 23) {
                gameSettings.weeklyResetHour = hour
              }
            }
            if (acfResponse.data.acf.weekly_reset_minute !== undefined) {
              const minute = typeof acfResponse.data.acf.weekly_reset_minute === 'string' 
                ? parseInt(acfResponse.data.acf.weekly_reset_minute, 10) 
                : acfResponse.data.acf.weekly_reset_minute
              if (!isNaN(minute) && minute >= 0 && minute <= 59) {
                gameSettings.weeklyResetMinute = minute
              }
            }
            if (acfResponse.data.acf.daily_check_in_enabled !== undefined) {
              const value = acfResponse.data.acf.daily_check_in_enabled
              gameSettings.dailyCheckInEnabled = value === true || value === '1' || value === 1 || value === 'true'
            }
            if (acfResponse.data.acf.daily_check_in_launch_date) {
              gameSettings.dailyCheckInLaunchDate = await this.parseACFDateTime(acfResponse.data.acf.daily_check_in_launch_date)
            }
          }
        } catch (acfError) {
          console.warn('[getGameSettings] ACF REST API not available:', acfError)
        }
      }

      console.log(`[getGameSettings] Final parsed settings:`, {
        launchDate: gameSettings.launchDate?.toISOString(),
        gameState: gameSettings.gameState,
        weeklyResetEnabled: gameSettings.weeklyResetEnabled,
        weeklyResetDay: gameSettings.weeklyResetDay,
        weeklyResetHour: gameSettings.weeklyResetHour,
        weeklyResetMinute: gameSettings.weeklyResetMinute,
        dailyCheckInEnabled: gameSettings.dailyCheckInEnabled,
        dailyCheckInLaunchDate: gameSettings.dailyCheckInLaunchDate?.toISOString(),
      })

      // Cache for 60 seconds (same as game settings cache)
      await this.cacheManager.set(cacheKey, gameSettings, 60 * 1000)
      return gameSettings
    } catch (error) {
      console.error('[getGameSettings] WordPress API error:', error)
      return null
    }
  }

  /**
   * Fetch a base_app_code by code string from WordPress.
   * Returns the code details if found and valid (active + within date range), null otherwise.
   */
  async getBaseAppCode(code: string): Promise<BaseAppCode | null> {
    const searchCode = code.trim()
    const cacheKey = `wp:base_app_code:${searchCode.toLowerCase()}`
    const cached = await this.cacheManager.get<BaseAppCode | null>(cacheKey)
    if (cached !== undefined) {
      return cached
    }

    try {
      // Fetch all base_app_code posts and find matching code in ACF field
      const response = await this.wpClient.get('/wp-json/wp/v2/base_app_code', {
        params: {
          per_page: 100,
          _embed: true,
        },
      })

      for (const post of response.data) {
        const postData = post as {
          id: number
          acf?: {
            code?: string
            extra_plays?: number | string
            start?: string
            end?: string
            active?: boolean | string | number
          }
        }

        if (!postData.acf) continue

        // Check if code matches (case-insensitive)
        const postCode = postData.acf.code?.trim() || ''
        if (postCode.toLowerCase() !== searchCode.toLowerCase()) continue

        // Parse ACF fields
        const active = postData.acf.active === true || postData.acf.active === '1' || postData.acf.active === 1 || postData.acf.active === 'true'
        
        const extraPlays = typeof postData.acf.extra_plays === 'string'
          ? parseInt(postData.acf.extra_plays, 10)
          : (postData.acf.extra_plays ?? 0)

        const start = postData.acf.start ? await this.parseACFDateTime(postData.acf.start) : null
        const end = postData.acf.end ? await this.parseACFDateTime(postData.acf.end) : null

        if (!start || !end) continue

        const result: BaseAppCode = {
          id: postData.id,
          code: postCode,
          extraPlays,
          start,
          end,
          active,
        }

        // Cache for 60 seconds
        await this.cacheManager.set(cacheKey, result, 60 * 1000)
        return result
      }

      // Code not found - cache null result briefly to avoid hammering WP
      await this.cacheManager.set(cacheKey, null, 30 * 1000)
      return null
    } catch (error) {
      console.error('[getBaseAppCode] WordPress API error:', error)
      return null
    }
  }
}
