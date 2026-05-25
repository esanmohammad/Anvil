/**
 * Embedder chooser. Wires memory-core's `setEmbedder()` to one of three
 * providers, selected at boot:
 *
 *   - `auto`   (default) — probes Ollama; uses it if reachable, falls back
 *                          to local Transformers.js.
 *   - `ollama` — bge-m3 via Ollama daemon (1024-dim, higher quality).
 *   - `local`  — all-MiniLM-L6-v2 via Transformers.js (384-dim, in-process,
 *                no external dep). Semble-style: small distilled model,
 *                no GPU, no API.
 *   - `none`   — explicitly disable. `vectorSearch` returns []; hybrid
 *                retrieval degrades to BM25 + graph.
 *
 * **Dimension warning**: switching providers mid-stream produces a mixed
 * LanceDB table (384-dim and 1024-dim rows). Search results from the wrong
 * provider will silently rank poorly. After a deliberate switch, wipe
 * `~/.anvil/memory/<project>/memory_vectors.lance` and let the sleeptime
 * backfill repopulate. Surfaced via a stderr warning when the resolved
 * dimension changes between boots; tracked in
 * `MEMORY-CORE-COMPLETENESS-PLAN.md §7` as a follow-up to make rows
 * provider-tagged.
 *
 * Env knobs:
 *   - `ANVIL_MEMORY_EMBED_PROVIDER` = `auto`|`ollama`|`local`|`none`
 *   - `ANVIL_MEMORY_EMBED_DISABLED=1` — hard off (equivalent to `none`)
 *   - `ANVIL_MEMORY_EMBED_MODEL` — per-provider model override
 *   - `OLLAMA_HOST` — Ollama base URL (default `http://localhost:11434`)
 *   - `ANVIL_MEMORY_EMBED_CACHE_DIR` — Transformers.js model cache dir
 */

import { setEmbedder } from '@esankhan3/anvil-memory-core';
import { createOllamaEmbedder, probeOllamaReachable } from './embedders/ollama-embedder.js';
import { createLocalEmbedder } from './embedders/local-embedder.js';

export type EmbedderProvider = 'auto' | 'ollama' | 'local' | 'none';

export interface InstallMemoryEmbedderOptions {
  /** Force a specific provider. Env-derived when omitted. */
  provider?: EmbedderProvider;
  ollamaHost?: string;
  model?: string;
}

function resolveProvider(forced?: EmbedderProvider): EmbedderProvider {
  if (forced) return forced;
  if (process.env.ANVIL_MEMORY_EMBED_DISABLED === '1') return 'none';
  const env = (process.env.ANVIL_MEMORY_EMBED_PROVIDER ?? 'auto').toLowerCase();
  if (env === 'ollama' || env === 'local' || env === 'none') return env;
  return 'auto';
}

export async function installMemoryEmbedder(
  opts: InstallMemoryEmbedderOptions = {},
): Promise<void> {
  const chosen = resolveProvider(opts.provider);
  if (chosen === 'none') {
    setEmbedder(null);
    console.log('[dashboard] memory embedder: disabled');
    return;
  }

  if (chosen === 'ollama') {
    setEmbedder(createOllamaEmbedder({ ollamaHost: opts.ollamaHost, model: opts.model }));
    console.log(
      `[dashboard] memory embedder: ollama (${opts.model ?? process.env.ANVIL_MEMORY_EMBED_MODEL ?? 'bge-m3'}) ` +
        `at ${(opts.ollamaHost ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/+$/, '')}`,
    );
    return;
  }

  if (chosen === 'local') {
    setEmbedder(createLocalEmbedder({ model: opts.model }));
    console.log(
      `[dashboard] memory embedder: local Transformers.js ` +
        `(${opts.model ?? process.env.ANVIL_MEMORY_EMBED_MODEL ?? 'Xenova/all-MiniLM-L6-v2'})`,
    );
    return;
  }

  // chosen === 'auto' — probe Ollama, fall back to local
  const ollamaUp = await probeOllamaReachable(opts.ollamaHost);
  if (ollamaUp) {
    setEmbedder(createOllamaEmbedder({ ollamaHost: opts.ollamaHost, model: opts.model }));
    console.log('[dashboard] memory embedder: ollama (auto-selected, daemon reachable)');
  } else {
    setEmbedder(createLocalEmbedder({ model: opts.model }));
    console.log(
      '[dashboard] memory embedder: local Transformers.js (auto-selected, Ollama unreachable)',
    );
  }
}
