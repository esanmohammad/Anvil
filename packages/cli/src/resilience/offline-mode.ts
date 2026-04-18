/**
 * OfflineDetector — check connectivity, use caches, queue operations.
 */

import { request } from 'node:https';

export interface OfflineStatus {
  online: boolean;
  checkedAt: string;
  latencyMs?: number;
}

export interface QueuedOperation {
  id: string;
  description: string;
  execute: () => Promise<unknown>;
  queuedAt: string;
}

export class OfflineDetector {
  private operationQueue: QueuedOperation[] = [];
  private lastStatus: OfflineStatus | null = null;
  private nextId = 0;

  /** Check internet connectivity by making an HTTPS HEAD request. */
  async checkConnectivity(
    url: string = 'https://api.github.com',
    timeoutMs: number = 5000,
  ): Promise<OfflineStatus> {
    const start = Date.now();
    try {
      await new Promise<void>((resolve, reject) => {
        const req = request(url, { method: 'HEAD', timeout: timeoutMs }, (res) => {
          res.resume();
          resolve();
        });
        req.on('error', reject);
        req.on('timeout', () => {
          req.destroy();
          reject(new Error('Timeout'));
        });
        req.end();
      });
      this.lastStatus = {
        online: true,
        checkedAt: new Date().toISOString(),
        latencyMs: Date.now() - start,
      };
    } catch {
      this.lastStatus = {
        online: false,
        checkedAt: new Date().toISOString(),
      };
    }
    return this.lastStatus;
  }

  /** Get last known connectivity status. */
  getLastStatus(): OfflineStatus | null {
    return this.lastStatus;
  }

  /** Queue an operation for later execution when connectivity returns. */
  queueOperation(description: string, execute: () => Promise<unknown>): string {
    const id = `offline-op-${this.nextId++}`;
    this.operationQueue.push({
      id,
      description,
      execute,
      queuedAt: new Date().toISOString(),
    });
    return id;
  }

  /** Flush queued operations. Returns counts. */
  async flushQueue(): Promise<{ succeeded: number; failed: number }> {
    let succeeded = 0;
    let failed = 0;

    const ops = [...this.operationQueue];
    this.operationQueue = [];

    for (const op of ops) {
      try {
        await op.execute();
        succeeded++;
      } catch {
        failed++;
      }
    }

    return { succeeded, failed };
  }

  /** Get the number of queued operations. */
  getQueueSize(): number {
    return this.operationQueue.length;
  }

  /** Get queued operations. */
  getQueuedOperations(): readonly QueuedOperation[] {
    return this.operationQueue;
  }
}
