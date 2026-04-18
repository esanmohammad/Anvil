/**
 * DeployResilience — catch sandbox/deploy failures, skip gracefully, continue pipeline.
 */

export interface DeployResilienceResult<T> {
  success: boolean;
  value?: T;
  skipped: boolean;
  error?: string;
}

export class DeployResilience {
  /**
   * Wrap a deploy/sandbox operation. On failure, returns a skip result
   * so the pipeline can continue to PR creation.
   */
  async execute<T>(operation: () => Promise<T>): Promise<DeployResilienceResult<T>> {
    try {
      const value = await operation();
      return { success: true, value, skipped: false };
    } catch (err) {
      return {
        success: false,
        skipped: true,
        error: (err as Error).message,
      };
    }
  }

  /**
   * Check whether a deploy result should block the pipeline.
   * Deploy failures are non-blocking by design.
   */
  shouldBlock(_result: DeployResilienceResult<unknown>): boolean {
    return false;
  }
}
