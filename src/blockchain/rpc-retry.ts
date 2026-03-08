import { HttpRequestError } from 'viem'

const DEFAULT_MAX_RETRIES = 5
const DEFAULT_INITIAL_DELAY_MS = 1000
const DEFAULT_MAX_DELAY_MS = 60_000

/**
 * Returns true if the error is a retryable RPC/HTTP error (e.g. 429 rate limit, 503 unavailable).
 */
export function isRetryableRpcError(err: unknown): boolean {
  if (err instanceof HttpRequestError && err.status !== undefined) {
    return err.status === 429 || err.status === 503
  }
  const msg = err instanceof Error ? err.message : String(err)
  return (
    /429|too many requests|rate limit/i.test(msg) ||
    /503|service unavailable/i.test(msg)
  )
}

export interface RpcRetryOptions {
  maxRetries?: number
  initialDelayMs?: number
  maxDelayMs?: number
  isRetryable?: (err: unknown) => boolean
  onRetry?: (attempt: number, err: unknown, delayMs: number) => void
}

/**
 * Runs an async RPC operation and retries with exponential backoff on 429/503.
 * Keeps retry logic DRY for all blockchain RPC calls (e.g. mainnet.base.org rate limits).
 */
export async function withRpcRetry<T>(
  fn: () => Promise<T>,
  options: RpcRetryOptions = {},
): Promise<T> {
  const {
    maxRetries = DEFAULT_MAX_RETRIES,
    initialDelayMs = DEFAULT_INITIAL_DELAY_MS,
    maxDelayMs = DEFAULT_MAX_DELAY_MS,
    isRetryable = isRetryableRpcError,
    onRetry,
  } = options

  let lastErr: unknown
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn()
    } catch (err) {
      lastErr = err
      if (attempt === maxRetries || !isRetryable(err)) {
        throw err
      }
      const delayMs = Math.min(
        initialDelayMs * Math.pow(2, attempt) + Math.random() * 1000,
        maxDelayMs,
      )
      onRetry?.(attempt + 1, err, delayMs)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
  throw lastErr
}
