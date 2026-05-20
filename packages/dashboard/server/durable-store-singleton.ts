/**
 * Process-wide `DurableStore` singleton — opens the SQLite WAL at
 * `~/.anvil/durable.db` once, hands the same handle to every
 * `PipelineRunner` constructed in the process.
 *
 * Phase D3 of the durable execution rollout. The store is the
 * authoritative record of every step + every effect; the audit-log
 * + dashboard-state hooks remain as secondary projections.
 *
 * Set `ANVIL_DURABLE_DISABLED=1` to opt out (useful for tests that
 * spin up an isolated PipelineRunner without touching real disk).
 * When disabled, every `getDurableStore()` call returns `null`; the
 * runner falls through to non-durable Pipeline.run() (passthrough
 * effect runtime) so behavior matches pre-D2 semantics.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, existsSync } from 'node:fs';
import { hostname } from 'node:os';

import { SQLiteDurableStore, type DurableStore } from '@esankhan3/anvil-core-pipeline';

let cached: DurableStore | null | undefined;

function anvilHomeDir(): string {
  const env = process.env.ANVIL_HOME;
  if (env) return env;
  return join(homedir(), '.anvil');
}

/** Returns the shared `DurableStore` for this process, or `null` when disabled. */
export function getDurableStore(): DurableStore | null {
  if (cached !== undefined) return cached;
  if (process.env.ANVIL_DURABLE_DISABLED === '1') {
    cached = null;
    return null;
  }
  const root = anvilHomeDir();
  if (!existsSync(root)) mkdirSync(root, { recursive: true });
  const dbPath = join(root, 'durable.db');
  try {
    cached = new SQLiteDurableStore({ path: dbPath });
  } catch (err) {
    console.warn(
      `[durable] Failed to open ${dbPath}; falling back to non-durable mode: ${err instanceof Error ? err.message : err}`,
    );
    cached = null;
  }
  return cached;
}

/** Test seam — drops the singleton so the next call re-opens. */
export function _resetDurableStoreSingleton(): void {
  if (cached) {
    void cached.close().catch(() => {});
  }
  cached = undefined;
}

/** A stable lease holder identity for this process. */
export function durableHolderId(): string {
  return `${process.pid}@${hostname()}`;
}
