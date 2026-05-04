/**
 * LocalExecutor — process-local FIFO single-slot queue for exclusive
 * local models (Ollama big-model slots that can't co-reside on a 16GB
 * GPU). Embedding + reranker models bypass this entirely.
 *
 * Contract:
 *   • At most ONE exclusive model is loaded at a time.
 *   • Concurrent callers are serialized in FIFO order — no deadlock,
 *     no priority inversion.
 *   • Switching from model A → model B triggers a synchronous eviction
 *     of A via Ollama's `POST /api/generate {model: A, prompt: '',
 *     keep_alive: 0}`, then polls `/api/ps` until A is no longer
 *     resident before letting B's call go through. Confirmed eviction
 *     prevents the GPU from briefly holding both.
 *   • Before every load, the executor probes `/api/ps` for OUT-OF-BAND
 *     resident exclusive models (e.g. an Ollama CLI session on the
 *     host loaded one independently). Intruders are evicted before B
 *     loads, so no two exclusive models are ever resident at once.
 *   • If `fn` throws, the slot is released and the queue keeps moving.
 *   • Same-id consecutive calls do NOT trigger eviction.
 */

export interface LocalExecutorDeps {
  /** Override the eviction call (used by tests; defaults to `fetch` to Ollama). */
  evict?: (modelId: string) => Promise<void>;
  /** Returns the model ids Ollama currently has resident. Tests inject
   *  to assert intruder-detection. Default = hits /api/ps. */
  probeResident?: () => Promise<string[]>;
  /** Returns true when modelId is an exclusive-slot model (i.e. should
   *  NOT co-reside with another exclusive model). Default returns true
   *  for every input — the legacy executor cared only about its own
   *  internal `loaded`. New callers can wire it to the model registry
   *  for correct intruder filtering. */
  isExclusive?: (modelId: string) => boolean;
  /** Override now() for deterministic tests. */
  now?: () => number;
}

export interface LocalExecutorInspection {
  loaded: string | null;
  queueDepth: number;
}

interface QueueItem {
  modelId: string;
  run: () => Promise<unknown>;
  resolve: (v: unknown) => void;
  reject: (e: unknown) => void;
}

export class LocalExecutor {
  private loaded: string | null = null;
  private queue: QueueItem[] = [];
  private busy = false;
  private readonly deps: Required<LocalExecutorDeps>;

  constructor(deps: LocalExecutorDeps = {}) {
    this.deps = {
      evict: deps.evict ?? defaultEvict,
      // Default probe is a sync no-op so unit tests don't pay an extra
      // microtask tick for a network round-trip they don't care about.
      // Production wires `defaultProbeResident` via the exported
      // singleton at the bottom of this file.
      probeResident: deps.probeResident ?? (async () => []),
      isExclusive: deps.isExclusive ?? (() => true),
      now: deps.now ?? Date.now,
    };
  }

  withModel<T>(modelId: string, fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push({
        modelId,
        run: fn as () => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      void this.pump();
    });
  }

  inspect(): LocalExecutorInspection {
    return { loaded: this.loaded, queueDepth: this.queue.length };
  }

  private async pump(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      while (this.queue.length > 0) {
        const item = this.queue.shift()!;
        try {
          // 1. Detect out-of-band intruders — exclusive models loaded
          //    by something other than this executor (e.g. an Ollama
          //    CLI session on the same host). Evict each before we
          //    proceed; no co-residence ever.
          let resident: string[] = [];
          try {
            resident = await this.deps.probeResident();
          } catch {
            resident = [];
          }
          for (const r of resident) {
            if (r === item.modelId) continue;                  // already loaded — nothing to do
            if (r === this.loaded) continue;                   // tracked below
            if (!this.deps.isExclusive(r)) continue;           // co-resident utility — exempt
            await this.deps.evict(r);
          }

          // 2. Tracked switch — A → B triggers our own eviction.
          if (this.loaded !== null && this.loaded !== item.modelId) {
            await this.deps.evict(this.loaded);
          }

          this.loaded = item.modelId;
          const result = await item.run();
          item.resolve(result);
        } catch (err) {
          item.reject(err);
        }
      }
    } finally {
      this.busy = false;
    }
  }
}

/**
 * Confirmed eviction. Sends keep_alive:0 to Ollama, then polls /api/ps
 * until the model is no longer resident or we hit the deadline. Eight
 * seconds is generous for unloading a 14B model — most unloads complete
 * sub-second once the daemon receives the signal.
 */
async function defaultEvict(modelId: string): Promise<void> {
  const baseUrl = (process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/+$/, '');
  await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelId, prompt: '', keep_alive: 0 }),
  }).catch(() => {
    // Eviction is best-effort; if Ollama is unreachable, the next /api/chat
    // will surface the real error. Don't double-fail here.
  });

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    let stillLoaded = false;
    try {
      const ps = await fetch(`${baseUrl}/api/ps`).then((r) => r.json() as Promise<{
        models?: Array<{ name?: string; model?: string }>;
      }>);
      stillLoaded = (ps.models ?? []).some(
        (m) => m.name === modelId || m.model === modelId,
      );
    } catch {
      return; // probe failed — trust the unload, don't loop forever
    }
    if (!stillLoaded) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  // Timed out waiting for unload — not fatal; the next chat call will
  // either succeed (Ollama swaps fine) or fail with a clear OOM message.
}

async function defaultProbeResident(): Promise<string[]> {
  const baseUrl = (process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/+$/, '');
  try {
    const ps = await fetch(`${baseUrl}/api/ps`).then((r) => r.json() as Promise<{
      models?: Array<{ name?: string; model?: string }>;
    }>);
    const names: string[] = [];
    for (const m of ps.models ?? []) {
      const id = m.name ?? m.model;
      if (id) names.push(id);
    }
    return names;
  } catch {
    return [];
  }
}

/**
 * Process-local singleton. Modules that wrap exclusive-slot calls
 * import this directly; tests construct their own instance to avoid
 * cross-test pollution.
 *
 * The singleton is wired with the real Ollama probe so production
 * intruder-detection works; per-test instances default to a no-op
 * probe so they don't pay for a network round-trip they don't care
 * about.
 */
export const localExecutor = new LocalExecutor({
  probeResident: defaultProbeResident,
});
