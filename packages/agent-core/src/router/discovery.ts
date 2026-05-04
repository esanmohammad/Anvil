/**
 * Discovery — boot-time pass that pings each model's provider for liveness
 * and writes the result into `registry.availability`. The resolver later
 * consults this map to filter unavailable models.
 *
 * Mutates the registry in place. Idempotent — re-running just refreshes
 * the timestamps. Capability metadata is NEVER changed by this pass; only
 * `availability` is touched.
 */
import type { ProviderName } from '../types.js';
import type { ModelRegistry } from './model-registry.js';

export interface DiscoveryAdapter {
  checkAvailability(): Promise<{ available: boolean; version?: string; error?: string }>;
}

export interface DiscoveryDeps {
  /** Resolve a provider name to an adapter that can `checkAvailability`. */
  getAdapter(provider: ProviderName): DiscoveryAdapter | undefined;
  now?: () => number;
}

export interface DiscoveryOptions {
  /** Per-provider timeout for `checkAvailability`. Default 3000ms. */
  timeoutMs?: number;
}

/**
 * Walks the registry, probes each model's provider, and writes the result
 * into `registry.availability`. One probe per UNIQUE provider — adapters
 * report at the provider level, so the result is replicated across all
 * registry entries that share that provider.
 *
 * Returns the same registry reference (mutation), so callers can chain.
 */
export async function discoverAvailability(
  registry: ModelRegistry,
  deps: DiscoveryDeps,
  opts: DiscoveryOptions = {},
): Promise<ModelRegistry> {
  const timeoutMs = opts.timeoutMs ?? 3000;
  const now = deps.now ?? Date.now;

  if (!registry.availability) registry.availability = new Map();
  const map = registry.availability;

  const providersInUse = new Set<ProviderName>();
  for (const m of registry.models) providersInUse.add(m.provider);

  const probes = Array.from(providersInUse).map(async (provider) => {
    const adapter = deps.getAdapter(provider);
    if (!adapter) {
      return { provider, result: { available: false, error: 'no adapter registered' } };
    }
    try {
      const result = await raceWithTimeout(adapter.checkAvailability(), timeoutMs);
      return { provider, result };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      return { provider, result: { available: false, error } };
    }
  });

  const settled = await Promise.all(probes);
  const byProvider = new Map<ProviderName, { available: boolean; error?: string }>();
  for (const { provider, result } of settled) {
    byProvider.set(provider, { available: result.available, error: result.error });
  }

  const ts = now();
  for (const m of registry.models) {
    const probe = byProvider.get(m.provider);
    map.set(m.id, {
      available: probe?.available === true,
      lastChecked: ts,
      error: probe?.error,
    });
  }

  return registry;
}

function raceWithTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}
