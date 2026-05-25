/**
 * Per-provider fetch dispatcher pool.
 *
 * Each upstream provider gets its own bounded-keep-alive `undici.Agent`.
 * Adapters pass `dispatcher: getFetchPool(provider)` to every fetch.
 * On a network-layer failure (TypeError: fetch failed / ECONNRESET / EPIPE),
 * adapters call `recycleFetchPoolOnFailure(provider, err)` so the next
 * fetch to the same provider lands on a fresh socket pool.
 *
 * Why: Node's default global undici dispatcher can retain zombie sockets
 * after OS sleep/wake or VPN flips. One poisoned global pool burns every
 * provider at once. Per-provider pools + heal-on-failure isolate the blast
 * radius and self-recover without process restart.
 */
import { Agent } from 'undici';

export type ProviderId =
  | 'anthropic'
  | 'opencode'
  | 'openrouter'
  | 'openai'
  | 'gemini'
  | 'ollama'
  | 'unknown';

interface PoolEntry {
  agent: Agent;
  createdAt: string;
  recycleCount: number;
  lastRecycleAt: string | null;
  lastRecycleReason: string | null;
  recycling: Promise<void> | null;
}

const POOL_OPTS: Agent.Options = {
  keepAliveTimeout: 4_000,
  keepAliveMaxTimeout: 10_000,
  connections: 32,
  pipelining: 1,
  // No dispatcher-level I/O timeouts — every caller already owns its
  // own per-call AbortSignal (run()'s AbortController for agentic
  // adapters; AbortSignal.timeout(...) for short probes). The previous
  // 30s headers / 60s body ceilings were appropriate for short REST
  // calls but hostile to LLM streaming: premium reasoning models can
  // take >30s to first byte and pause >60s between SSE chunks, both
  // of which manifest as `TypeError: fetch failed` that the chain
  // walker can't distinguish from a real network failure.
  // 0 = no timeout; the per-call signal is the single source of truth.
  bodyTimeout: 0,
  headersTimeout: 0,
};

const pools = new Map<ProviderId, PoolEntry>();

function makeEntry(): PoolEntry {
  return {
    agent: new Agent(POOL_OPTS),
    createdAt: new Date().toISOString(),
    recycleCount: 0,
    lastRecycleAt: null,
    lastRecycleReason: null,
    recycling: null,
  };
}

/**
 * Get the dispatcher for a provider. Lazily constructs on first call.
 * Always returns a non-recycling Agent — callers pass it via fetch options.
 */
export function getFetchPool(provider: ProviderId): Agent {
  let entry = pools.get(provider);
  if (!entry) {
    entry = makeEntry();
    pools.set(provider, entry);
  }
  return entry.agent;
}

const POISONED_PATTERNS =
  /fetch\s+failed|ECONNRESET|socket\s+hang\s+up|other\s+side\s+closed|EPIPE|ETIMEDOUT|UND_ERR_SOCKET/i;

/**
 * Recycle the dispatcher for a provider when a fetch failure indicates pool
 * poisoning. Idempotent under concurrent calls — multiple in-flight failures
 * coalesce to one recycle. The promise resolves once the new pool is ready.
 * Safe to fire-and-forget — the throw site re-throws the original error to
 * feed the chain walker.
 */
export function recycleFetchPoolOnFailure(
  provider: ProviderId,
  err: unknown,
): Promise<void> {
  const msg = err instanceof Error ? err.message : String(err);
  const causeMsg =
    err instanceof Error && 'cause' in err && err.cause
      ? err.cause instanceof Error
        ? err.cause.message
        : String(err.cause)
      : '';
  const haystack = `${msg} ${causeMsg}`;
  if (!POISONED_PATTERNS.test(haystack)) return Promise.resolve();

  let entry = pools.get(provider);
  if (!entry) {
    entry = makeEntry();
    pools.set(provider, entry);
    return Promise.resolve();
  }

  if (entry.recycling) return entry.recycling;

  const reason = (msg + (causeMsg ? ` :: ${causeMsg}` : '')).slice(0, 200);
  const old = entry.agent;
  const newAgent = new Agent(POOL_OPTS);
  entry.agent = newAgent;
  entry.recycleCount += 1;
  entry.lastRecycleAt = new Date().toISOString();
  entry.lastRecycleReason = reason;

  const recycling = (async () => {
    try {
      await old.close();
    } catch {
      // Old pool was already broken — that's why we're recycling.
    }
  })().finally(() => {
    if (entry!.recycling === recycling) entry!.recycling = null;
  });

  entry.recycling = recycling;
  return recycling;
}

export interface PoolMetrics {
  provider: ProviderId;
  createdAt: string;
  recycleCount: number;
  lastRecycleAt: string | null;
  lastRecycleReason: string | null;
  active: boolean;
}

/**
 * Diagnostic: read-only snapshot of every pool's state.
 */
export function getPoolMetrics(): PoolMetrics[] {
  const out: PoolMetrics[] = [];
  for (const [provider, entry] of pools) {
    out.push({
      provider,
      createdAt: entry.createdAt,
      recycleCount: entry.recycleCount,
      lastRecycleAt: entry.lastRecycleAt,
      lastRecycleReason: entry.lastRecycleReason,
      active: entry.recycling === null,
    });
  }
  return out;
}

/**
 * Test utility — drops every pool and resets counters. Not exported via
 * the package barrel; tests import from the subpath.
 */
export async function resetAllPools(): Promise<void> {
  const closes: Promise<void>[] = [];
  for (const entry of pools.values()) {
    closes.push(entry.agent.close().catch(() => {}));
  }
  pools.clear();
  await Promise.all(closes);
}
