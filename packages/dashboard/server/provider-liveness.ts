/**
 * Provider liveness probe + resolver-chain walker.
 *
 * The registry resolver returns `{ primary, fallbacks }`. When the
 * primary's provider is down (Ollama not running, missing API key)
 * we walk the chain instead of letting the run fail. Probes are
 * cached for 30 seconds — enough to amortize across one stage's
 * fanout, short enough that bringing Ollama back up is felt within
 * one minute.
 */

import type { ProviderName, ResolvedChain } from '@anvil/agent-core';

interface LivenessRecord {
  alive: boolean;
  checkedAt: number;
}

const TTL_MS = 30_000;
const cache = new Map<ProviderName, LivenessRecord>();

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
 *
 * Returns: { model, provider, fellBackFrom? } where fellBackFrom is
 * set when the primary was bypassed.
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

  // Nothing alive → return primary anyway. The adapter will throw a
  // clear error when its own checkAvailability fails; better that than
  // silently routing to a dead second-choice we don't know about.
  return { model: chain.primary, provider: primaryProvider, fellBackFrom: undefined };
}

/**
 * Synchronous chain walker — uses ONLY cached probe results. Returns
 * the primary unchanged when the cache is cold. Pair with
 * `prefetchLiveness()` at run start so the cache is warm by the time
 * stages fire.
 */
export function pickAliveModelFromChainSync(
  chain: ResolvedChain,
  providerOf: (modelId: string) => ProviderName,
): { model: string; provider: ProviderName; fellBackFrom?: string } {
  const primaryProvider = providerOf(chain.primary);
  const primaryRecord = cache.get(primaryProvider);
  // Cold cache or alive primary → no fallback.
  if (!primaryRecord || primaryRecord.alive) {
    return { model: chain.primary, provider: primaryProvider };
  }

  for (const fb of chain.fallbacks) {
    const p = providerOf(fb.model);
    const rec = cache.get(p);
    if (!rec || rec.alive) {
      return { model: fb.model, provider: p, fellBackFrom: chain.primary };
    }
  }
  return { model: chain.primary, provider: primaryProvider };
}

/**
 * Pre-warm the liveness cache for a set of providers. Called once at
 * pipeline start so the sync chain walker has data to read. Probes
 * run in parallel; failures are non-fatal (cache stays cold for that
 * provider, sync walker treats it as alive).
 */
export async function prefetchLiveness(providers: ProviderName[]): Promise<void> {
  await Promise.all(providers.map((p) => isProviderAlive(p)));
}

/** Test-only — clear the cache between cases. */
export function _resetLivenessCache(): void {
  cache.clear();
}

// ───────────────────────────────────────────────────────────────────────
// Probes
// ───────────────────────────────────────────────────────────────────────

async function probe(provider: ProviderName): Promise<boolean> {
  switch (provider) {
    case 'ollama': return probeOllama();
    case 'claude': return Boolean(process.env.ANTHROPIC_API_KEY);
    case 'openai': return Boolean(process.env.OPENAI_API_KEY);
    case 'openrouter': return Boolean(process.env.OPENROUTER_API_KEY);
    case 'gemini':
    case 'gemini-cli': return Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY);
    case 'adk': return true;          // adk runs in-process; no remote dep
    default: return true;
  }
}

async function probeOllama(): Promise<boolean> {
  const baseUrl = (process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/+$/, '');
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2000);
    const res = await fetch(`${baseUrl}/api/tags`, { signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}
