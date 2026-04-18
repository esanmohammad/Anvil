/**
 * McpResilience — timeout wrapper for MCP tool calls with fallback on timeout.
 */

export interface McpResilienceConfig {
  /** Timeout for MCP calls in ms. Default 30_000. */
  timeoutMs: number;
}

export interface McpCallResult<T> {
  success: boolean;
  value?: T;
  timedOut: boolean;
  error?: string;
  durationMs: number;
}

const DEFAULT_CONFIG: McpResilienceConfig = {
  timeoutMs: 30_000,
};

export class McpResilience {
  private config: McpResilienceConfig;

  constructor(config?: Partial<McpResilienceConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Wrap an async MCP call with a timeout.
   * Returns a result with success/timeout info.
   * On timeout, optionally calls the fallback.
   */
  async callWithTimeout<T>(
    fn: () => Promise<T>,
    fallback?: () => T,
  ): Promise<McpCallResult<T>> {
    const start = Date.now();

    try {
      const value = await Promise.race([
        fn(),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error('MCP_TIMEOUT')),
            this.config.timeoutMs,
          ),
        ),
      ]);
      return {
        success: true,
        value,
        timedOut: false,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      const durationMs = Date.now() - start;
      const errorMsg = (err as Error).message;
      const timedOut = errorMsg === 'MCP_TIMEOUT';

      if (timedOut && fallback) {
        return {
          success: true,
          value: fallback(),
          timedOut: true,
          durationMs,
        };
      }

      return {
        success: false,
        timedOut,
        error: errorMsg,
        durationMs,
      };
    }
  }

  /** Get the configured timeout. */
  getTimeoutMs(): number {
    return this.config.timeoutMs;
  }
}
