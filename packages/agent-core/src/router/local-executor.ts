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
 *     keep_alive: 0}`. The next call (loading B) only proceeds after
 *     the eviction settles.
 *   • If `fn` throws, the slot is released and the queue keeps moving.
 *   • Same-id consecutive calls do NOT trigger eviction.
 */

export interface LocalExecutorDeps {
  /** Override the eviction call (used by tests; defaults to `fetch` to Ollama). */
  evict?: (modelId: string) => Promise<void>;
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

async function defaultEvict(modelId: string): Promise<void> {
  const baseUrl = process.env.OLLAMA_HOST ?? 'http://localhost:11434';
  await fetch(`${baseUrl}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: modelId, prompt: '', keep_alive: 0 }),
  }).catch(() => {
    // Eviction is best-effort; if Ollama is unreachable, the next /api/chat
    // will surface the real error. Don't double-fail here.
  });
}

/**
 * Process-local singleton. Modules that wrap exclusive-slot calls
 * import this directly; tests construct their own instance to avoid
 * cross-test pollution.
 */
export const localExecutor = new LocalExecutor();
