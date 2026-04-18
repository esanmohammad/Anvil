/**
 * RateLimitBackoff — detect 429s, parse Retry-After, exponential backoff.
 */

export interface RateLimitConfig {
  /** Max retries after rate limit. Default 5. */
  maxRetries: number;
  /** Initial backoff in ms. Default 1000. */
  initialBackoffMs: number;
  /** Backoff multiplier. Default 2. */
  backoffMultiplier: number;
  /** Max backoff in ms. Default 60_000. */
  maxBackoffMs: number;
}

export interface RateLimitInfo {
  isRateLimited: boolean;
  retryAfterMs?: number;
  remainingRetries: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  maxRetries: 5,
  initialBackoffMs: 1000,
  backoffMultiplier: 2,
  maxBackoffMs: 60_000,
};

export class RateLimitBackoff {
  private config: RateLimitConfig;

  constructor(config?: Partial<RateLimitConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Detect if an error/response indicates rate limiting. */
  isRateLimited(statusCode: number): boolean {
    return statusCode === 429;
  }

  /** Parse Retry-After header value (seconds or HTTP date) into ms. */
  parseRetryAfter(headerValue: string | null | undefined): number | null {
    if (!headerValue) return null;

    // Try parsing as number of seconds
    const seconds = Number(headerValue);
    if (!isNaN(seconds) && seconds > 0) {
      return seconds * 1000;
    }

    // Try parsing as HTTP date
    const date = new Date(headerValue);
    if (!isNaN(date.getTime())) {
      const delayMs = date.getTime() - Date.now();
      return delayMs > 0 ? delayMs : 0;
    }

    return null;
  }

  /** Calculate backoff delay for a given attempt. */
  getBackoffDelay(attempt: number, retryAfterMs?: number): number {
    if (retryAfterMs && retryAfterMs > 0) {
      return Math.min(retryAfterMs, this.config.maxBackoffMs);
    }
    const delay =
      this.config.initialBackoffMs *
      Math.pow(this.config.backoffMultiplier, attempt);
    return Math.min(delay, this.config.maxBackoffMs);
  }

  /** Execute a function with rate limit retry logic. */
  async executeWithBackoff<T>(
    fn: () => Promise<T>,
    isRateLimitError?: (err: unknown) => { rateLimited: boolean; retryAfterMs?: number },
  ): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err as Error;

        if (attempt >= this.config.maxRetries) break;

        let retryAfterMs: number | undefined;
        if (isRateLimitError) {
          const info = isRateLimitError(err);
          if (!info.rateLimited) throw lastError;
          retryAfterMs = info.retryAfterMs;
        }

        const delay = this.getBackoffDelay(attempt, retryAfterMs);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw lastError;
  }
}
