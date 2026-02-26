import { Controller, Get } from '@nestjs/common'
import { HealthCheck, HealthCheckService, MemoryHealthIndicator } from '@nestjs/terminus'
import { PrismaService } from '../prisma/prisma.service'

@Controller('health')
export class HealthController {
  constructor(
    private health: HealthCheckService,
    private memory: MemoryHealthIndicator,
    private prisma: PrismaService,
  ) {}

  /**
   * Liveness probe — used by k8s to decide if the container should be restarted.
   * Must be cheap: no DB, no Redis, no external calls.
   * Just confirms the Node.js process is alive and the event loop is not stuck.
   */
  @Get()
  async liveness() {
    return { status: 'ok' }
  }

  /**
   * Readiness probe — used by k8s to decide if traffic should be routed here.
   * Checks DB and memory; a failure means "don't send me requests" but does NOT restart the pod.
   */
  @Get('ready')
  @HealthCheck()
  async readiness() {
    return this.health.check([
      async () => {
        await this.prisma.$queryRaw`SELECT 1`
        return { database: { status: 'up' } }
      },
      () => this.memory.checkHeap('memory_heap', 500 * 1024 * 1024),
      () => this.memory.checkRSS('memory_rss', 1024 * 1024 * 1024),
    ])
  }
}
