/**
 * Provider liveness probe + resolver-chain walker.
 *
 * The registry resolver returns `{ primary, fallbacks }`. When the
 * primary's provider is down (Ollama not running, missing API key)
 * we walk the chain instead of letting the run fail. Probes are
 * cached for 30 seconds — enough to amortize across one stage's
 * fanout, short enough that bringing Ollama back up is felt within
 * one minute.
 *
 * Lives in agent-core because the probes are provider-specific
 * (Ollama HTTP, env-var presence). Both cli and dashboard share the
 * same liveness state via the module-scoped cache.
 */

import type { ProviderName } from './types.js';
import type { ResolvedChain } from './router/resolver.js';
import { getFetchPool, recycleFetchPoolOnFailure } from './fetch-pool.js';

interface LivenessRecord {
  alive: boolean;
  checkedAt: number;
}

const DEFAULT_TTL_MS = 30_000;
let TTL_MS = DEFAULT_TTL_MS;
const cache = new Map<ProviderName, LivenessRecord>();

/**
 * Override the liveness-cache TTL at runtime. Read from
 * `walker.liveness_ttl_ms` in `~/.anvil/models.yaml` by callers at
 * startup. Pass 0 to disable caching entirely.
 */
export function setLivenessTtlMs(ttlMs: number): void {
  if (!Number.isFinite(ttlMs) || ttlMs < 0) return;
  TTL_MS = ttlMs;
}

/** Returns the current TTL — exposed for diagnostic logging. */
export function getLivenessTtlMs(): number {
  return TTL_MS;
}

/**
 * Returns true if the provider is currently believed to be reachable.
 * Cached; the first call per provider per 30s issues a real probe.
 */
export async function isProviderAlive(provider: ProviderName): Promise<boolean> {
  const now = Date.now();
  const cached = cache.get(provider);
  if (cached && now - cached.checkedAt < TTL_MS) return cached.alive;

  const alive = await probe(provider).catch(() => false);
  cache.set(provider, { alive, checkedAt: now });
  return alive;
}

/**
 * Walk a resolved chain and return the first model whose provider is
 * alive. Falls back to the primary even when the probe fails — better
 * to let the adapter surface the real error than to fabricate a
 * 'no-providers-alive' message at the resolver layer.
 */
export async function pickAliveModelFromChain(
  chain: ResolvedChain,
  providerOf: (modelId: string) => ProviderName,
): Promise<{ model: string; provider: ProviderName; fellBackFrom?: string }> {
  const primaryProvider = providerOf(chain.primary);
  if (await isProviderAlive(primaryProvider)) {
    return { model: chain.primary, provider: primaryProvider };
  }

  for (const fb of chain.fallbacks) {
    const p = providerOf(fb.model);
    if (await isProviderAlive(p)) {
      return { model: fb.model, provider: p, fellBackFrom: chain.primary };
    }
  }

  return { model: chain.primary, provider: primaryProvider, fellBackFrom: undefined };
}

/**
 * Synchronous chain walker — uses ONLY cached probe results. Returns
 * the primary unchanged when the cache is cold. Pair with
 * `prefetchLiveness()` at run start so the cache is warm by the time
 * stages fire.
 *
 * `excludeModels` is the runtime-burned set callers maintain: models
 * that hit a retryable UpstreamError (429 quota, rate-limit, 5xx)
 * earlier in this run. They're skipped even if their provider's
 * liveness probe says alive.
 */
export interface ChainWalkSkip {
  model: string;
  reason: 'burned' | 'liveness-dead';
}

export function pickAliveModelFromChainSync(
  chain: ResolvedChain,
  providerOf: (modelId: string) => ProviderName,
  excludeModels: ReadonlySet<string> = new Set(),
): { model: string; provider: ProviderName; fellBackFrom?: string; skipped?: ChainWalkSkip[] } {
  const candidates: Array<{ model: string; isFallback: boolean }> = [
    { model: chain.primary, isFallback: false },
    ...chain.fallbacks.map((fb) => ({ model: fb.model, isFallback: true })),
  ];

  let firstSkippedPrimary: string | undefined;
  const skipped: ChainWalkSkip[] = [];
  for (const c of candidates) {
    if (excludeModels.has(c.model)) {
      if (!c.isFallback) firstSkippedPrimary = c.model;
      skipped.push({ model: c.model, reason: 'burned' });
      continue;
    }
    const provider = providerOf(c.model);
    const rec = cache.get(provider);
    if (!rec || rec.alive) {
      const fellBack = c.isFallback || firstSkippedPrimary;
      return {
        model: c.model,
        provider,
        ...(fellBack ? { fellBackFrom: firstSkippedPrimary ?? chain.primary } : {}),
        ...(skipped.length > 0 ? { skipped } : {}),
      };
    }
    skipped.push({ model: c.model, reason: 'liveness-dead' });
  }
  return {
    model: chain.primary,
    provider: providerOf(chain.primary),
    ...(skipped.length > 0 ? { skipped } : {}),
  };
}

/**
 * Pre-warm the liveness cache for a set of providers. Called once at
 * pipeline start so the sync chain walker has data to read. Probes
 * run in parallel; failures are non-fatal.
 */
export async function prefetchLiveness(providers: ProviderName[]): Promise<void> {
  await Promise.all(providers.map((p) => isProviderAlive(p)));
}

/** Test-only — clear the cache between cases and reset TTL to default. */
export function _resetLivenessCache(): void {
  cache.clear();
  TTL_MS = DEFAULT_TTL_MS;
}

// ───────────────────────────────────────────────────────────────────────
// Probes
// ───────────────────────────────────────────────────────────────────────

async function probe(provider: ProviderName): Promise<boolean> {
  switch (provider) {
    case 'ollama':     return probeOllama();
    case 'claude':     return Boolean(process.env.ANTHROPIC_API_KEY);
    case 'openai':     return Boolean(process.env.OPENAI_API_KEY);
    case 'openrouter': return Boolean(process.env.OPENROUTER_API_KEY);
    case 'gemini':
    case 'gemini-cli': return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_GENAI_API_KEY || process.env.GOOGLE_API_KEY);
    case 'opencode':   return Boolean(process.env.OPENCODE_API_KEY);
    case 'adk':        return Boolean(
      process.env.ANTHROPIC_API_KEY ||
      process.env.GEMINI_API_KEY ||
      process.env.GOOGLE_GENAI_API_KEY ||
      process.env.GOOGLE_API_KEY,
    );
    default:           return true;
  }
}

async function probeOllama(): Promise<boolean> {
  const baseUrl = (process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/+$/, '');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${baseUrl}/api/tags`, {
      signal: ctrl.signal,
      // @ts-expect-error — undici dispatcher accepted by Node fetch at runtime
      dispatcher: getFetchPool('ollama'),
    });
    clearTimeout(timer);
    return res.ok;
  } catch (err) {
    // Probe failure isn't propagated, but it IS a signal the pool may
    // be poisoned — heal so the next real request gets a fresh socket.
    void recycleFetchPoolOnFailure('ollama', err);
    return false;
  }
}
