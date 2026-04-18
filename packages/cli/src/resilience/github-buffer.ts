/**
 * GitHubBuffer — detect GitHub API failures, buffer operations, retry with backoff.
 */

export interface BufferedOperation {
  id: string;
  operation: () => Promise<unknown>;
  attempts: number;
  lastError?: string;
  createdAt: number;
}

export interface GitHubBufferConfig {
  /** Max retry attempts. Default 3. */
  maxRetries: number;
  /** Initial backoff in ms. Default 1000. */
  initialBackoffMs: number;
  /** Backoff multiplier. Default 2. */
  backoffMultiplier: number;
}

const DEFAULT_CONFIG: GitHubBufferConfig = {
  maxRetries: 3,
  initialBackoffMs: 1000,
  backoffMultiplier: 2,
};

export class GitHubBuffer {
  private config: GitHubBufferConfig;
  private buffer: BufferedOperation[] = [];
  private nextId = 0;

  constructor(config?: Partial<GitHubBufferConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Execute an operation with retry logic. */
  async execute<T>(operation: () => Promise<T>): Promise<T> {
    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      try {
        return await operation();
      } catch (err) {
        lastError = err as Error;
        if (attempt < this.config.maxRetries) {
          const delay =
            this.config.initialBackoffMs *
            Math.pow(this.config.backoffMultiplier, attempt);
          await this.sleep(delay);
        }
      }
    }

    throw lastError;
  }

  /** Add an operation to the buffer for later retry. */
  addToBuffer(operation: () => Promise<unknown>): string {
    const id = `gh-op-${this.nextId++}`;
    this.buffer.push({
      id,
      operation,
      attempts: 0,
      createdAt: Date.now(),
    });
    return id;
  }

  /** Flush the buffer, retrying all buffered operations. */
  async flushBuffer(): Promise<{ succeeded: number; failed: number }> {
    let succeeded = 0;
    let failed = 0;

    const ops = [...this.buffer];
    this.buffer = [];

    for (const op of ops) {
      try {
        await this.execute(op.operation);
        succeeded++;
      } catch {
        failed++;
      }
    }

    return { succeeded, failed };
  }

  /** Get the number of buffered operations. */
  getBufferSize(): number {
    return this.buffer.length;
  }

  /** Calculate backoff delay for a given attempt number. */
  getBackoffDelay(attempt: number): number {
    return (
      this.config.initialBackoffMs *
      Math.pow(this.config.backoffMultiplier, attempt)
    );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
