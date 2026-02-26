import { Injectable, Inject } from '@nestjs/common'
import { CACHE_MANAGER } from '@nestjs/cache-manager'
import { Cache } from 'cache-manager'
import { ConfigService } from '@nestjs/config'
import { fromZonedTime, toZonedTime, formatInTimeZone } from 'date-fns-tz'
import axios, { AxiosInstance } from 'axios'

/**
 * Shared timezone service for parsing datetime strings in WordPress timezone context.
 * Used by both livestream and game systems to ensure consistent timezone handling.
 * 
 * This service follows the same timezone resolution as WordPress:
 * 1. WORDPRESS_TIMEZONE environment variable
 * 2. WordPress REST API endpoint (if exists)
 * 3. Fallback to UTC
 */
@Injectable()
export class TimezoneService {
  private wpTimezone: string | null = null
  private wpTimezoneCacheKey = 'wp:timezone'
  private wpClient: AxiosInstance | null = null

  constructor(
    @Inject(CACHE_MANAGER) private cacheManager: Cache,
    private configService: ConfigService,
  ) {
    // Initialize WordPress client for timezone API endpoint (optional)
    const wpUrl = this.configService.get<string>('WORDPRESS_URL', 'http://wordpress:80')
    this.wpClient = axios.create({
      baseURL: wpUrl,
      timeout: 5000,
    })
  }

  /**
   * Get WordPress timezone setting
   * Priority:
   * 1. WORDPRESS_TIMEZONE environment variable
   * 2. Try WordPress REST API endpoint (if custom endpoint exists)
   * 3. Fall back to UTC
   */
  async getWordPressTimezone(): Promise<string> {
    // Check cache first
    if (this.wpTimezone) {
      return this.wpTimezone
    }

    const cached = await this.cacheManager.get<string>(this.wpTimezoneCacheKey)
    if (cached) {
      this.wpTimezone = cached
      return cached
    }

    // First priority: Check environment variable
    const envTimezone = this.configService.get<string>('WORDPRESS_TIMEZONE')
    if (envTimezone) {
      this.wpTimezone = envTimezone
      await this.cacheManager.set(this.wpTimezoneCacheKey, this.wpTimezone, 3600 * 1000) // Cache for 1 hour (3600000ms)
      return this.wpTimezone
    }

    // Second priority: Try WordPress REST API endpoint (if it exists)
    if (this.wpClient) {
      try {
        const response = await this.wpClient.get('/wp-json/scl/v1/timezone', {
          timeout: 5000,
        })
        if (response.data && response.data.timezone) {
          this.wpTimezone = response.data.timezone
          await this.cacheManager.set(this.wpTimezoneCacheKey, this.wpTimezone, 3600 * 1000) // 1 hour
          return this.wpTimezone
        }
      } catch (customEndpointError) {
        // Custom endpoint doesn't exist, that's okay
      }
    }

    // Fallback: Default to UTC
    // Note: Set WORDPRESS_TIMEZONE environment variable to match WordPress admin timezone setting
    // (Settings → General → Timezone in WordPress admin)
    this.wpTimezone = 'UTC'
    await this.cacheManager.set(this.wpTimezoneCacheKey, this.wpTimezone, 3600 * 1000) // 1 hour
    return this.wpTimezone
  }

  /**
   * Parse datetime string in WordPress's timezone context
   * Handles datetime strings without timezone info (like ACF datetime fields)
   * 
   * Supports formats:
   * - "Y-m-d H:i:s" (e.g., "2026-02-17 14:00:00")
   * - "Y-m-d H:i" (e.g., "2026-02-17 14:00")
   * - ISO 8601 with timezone (e.g., "2026-02-17T14:00:00+00:00")
   * 
   * @param dateTimeString - DateTime string to parse (without timezone info)
   * @returns Date object in UTC, or null if parsing fails
   */
  async parseDateTime(dateTimeString: string): Promise<Date | null> {
    try {
      const wpTimezone = await this.getWordPressTimezone()
      const dateTimeStr = dateTimeString.trim()

      console.log(`[TimezoneService] Parsing: "${dateTimeStr}" in timezone: ${wpTimezone}`)

      let parsedDate: Date

      // Format: "Y-m-d H:i:s" (e.g., "2026-02-17 14:00:00")
      if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(dateTimeStr)) {
        // Parse components manually to avoid timezone interpretation
        const [datePart, timePart] = dateTimeStr.split(' ')
        const [year, month, day] = datePart.split('-').map(Number)
        const [hour, minute, second] = timePart.split(':').map(Number)
        // Create a date object with these components (will be treated as local time)
        // We'll use fromZonedTime to properly convert from WordPress timezone
        parsedDate = new Date(year, month - 1, day, hour, minute, second)
      }
      // Format: "Y-m-d H:i" (e.g., "2026-02-17 14:00")
      else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(dateTimeStr)) {
        const [datePart, timePart] = dateTimeStr.split(' ')
        const [year, month, day] = datePart.split('-').map(Number)
        const [hour, minute] = timePart.split(':').map(Number)
        parsedDate = new Date(year, month - 1, day, hour, minute, 0)
      }
      // Format: ISO 8601 with timezone (e.g., "2026-02-17T14:00:00+00:00")
      else if (dateTimeStr.includes('T') || dateTimeStr.includes('Z') || dateTimeStr.includes('+') || dateTimeStr.includes('-')) {
        // If it already has timezone info, parse directly
        parsedDate = new Date(dateTimeStr)
        // If it has timezone info, return it directly (already in correct timezone)
        if (!isNaN(parsedDate.getTime())) {
          return parsedDate
        }
      }
      // Try default Date parsing as fallback
      else {
        parsedDate = new Date(dateTimeStr)
      }

      if (!parsedDate || isNaN(parsedDate.getTime())) {
        console.warn(`[TimezoneService] Failed to parse datetime: ${dateTimeString}`)
        return null
      }

      // If WordPress timezone is UTC, we can use the date directly
      if (wpTimezone === 'UTC' || wpTimezone === 'Etc/UTC') {
        return parsedDate
      }

      // Convert from WordPress timezone to UTC
      // fromZonedTime treats the Date object as if it represents a time in the specified timezone
      // and converts it to UTC
      const utcDate = fromZonedTime(parsedDate, wpTimezone)
      console.log(`[TimezoneService] Converted "${dateTimeString}" (${wpTimezone}) → ${utcDate.toISOString()} (UTC)`)
      return utcDate
    } catch (error) {
      console.error(`[TimezoneService] Error parsing datetime "${dateTimeString}":`, error)
      // Fallback to simple Date parsing
      try {
        return new Date(dateTimeString)
      } catch {
        return null
      }
    }
  }

  /**
   * Format a date in WordPress timezone as YYYY-MM-DD
   * Useful for getting the date string in WordPress timezone
   */
  async formatDateInTimezone(date: Date): Promise<string> {
    const wpTimezone = await this.getWordPressTimezone()
    return formatInTimeZone(date, wpTimezone, 'yyyy-MM-dd')
  }

  /**
   * Get start of day in WordPress timezone for a given date
   * Returns a Date object in UTC representing midnight in WordPress timezone
   */
  async getStartOfDayInTimezone(date: Date): Promise<Date> {
    const wpTimezone = await this.getWordPressTimezone()
    const dateStr = await this.formatDateInTimezone(date)
    return await this.parseDateTime(`${dateStr} 00:00:00`) || date
  }

  /**
   * Clear the timezone cache (useful for testing or when timezone changes)
   */
  async clearTimezoneCache(): Promise<void> {
    this.wpTimezone = null
    await this.cacheManager.del(this.wpTimezoneCacheKey)
  }
}
