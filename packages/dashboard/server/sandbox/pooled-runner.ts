/**
 * Adapter that wraps a `SandboxRunner` with a `SandboxPool`,
 * exposing the same `SandboxRunner` interface so consumers don't
 * have to know whether the runner is pooled.
 *
 * Phase S follow-up #3 — `SandboxPool` was built in S7 but never
 * wrapped around the actual runners. This file is the seam.
 */

import type {
  AcquireSandboxOpts,
  SandboxHandle,
  SandboxRunner,
  SandboxRunnerListEntry,
} from '@esankhan3/anvil-core-pipeline';
import { SandboxPool, type PoolOptions } from './pool.js';

export class PooledSandboxRunner implements SandboxRunner {
  private readonly pool: SandboxPool;

  constructor(inner: SandboxRunner, opts: PoolOptions = {}) {
    this.pool = new SandboxPool(inner, opts);
  }

  async acquire(opts: AcquireSandboxOpts): Promise<SandboxHandle> {
    return this.pool.acquire(opts);
  }

  /** Pool-wrapped handles need a `release` path; otherwise the pool
   *  never sees idle slots. The runner consumer should call
   *  `release(handle)` when it's done with a handle for THIS run. */
  async release(handle: SandboxHandle): Promise<void> {
    return this.pool.release(handle);
  }

  async list(): Promise<readonly SandboxRunnerListEntry[]> {
    return this.pool.list();
  }

  async sweep(): Promise<{ closed: number }> {
    return this.pool.sweep();
  }

  async shutdown(): Promise<void> {
    return this.pool.shutdown();
  }
}
