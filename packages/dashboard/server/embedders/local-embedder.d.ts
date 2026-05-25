/**
 * Local (in-process) sentence-embedder backed by `@huggingface/transformers`
 * — the JS port of the HF transformers library running ONNX models in pure
 * JS (WebAssembly + native bindings where available). Same architectural
 * pattern as MinishLab's Semble: small distilled model, no GPU, no daemon,
 * no external API. We don't ship literal `model2vec` weights because the
 * pure-JS runtime path for static-lookup models isn't stable yet; instead
 * we use `Xenova/all-MiniLM-L6-v2` (384-dim, ~22 MB, sentence-transformers
 * baseline). Quality is ~80 % of `bge-m3` at < 5 % of the disk + RAM.
 *
 * First call downloads the model to `~/.cache/huggingface/` (~5-10s on
 * a typical connection); subsequent calls are ~50 ms cold, ~5 ms warm.
 *
 * Why this exists alongside the Ollama embedder: zero-setup environments
 * (CI, containers without Ollama, Codespaces, fresh laptops) should get
 * working vector retrieval out of the box. Ollama remains preferred when
 * available — higher embedding quality and a longer maximum-input window.
 */
import type { Embedder } from '@esankhan3/anvil-memory-core';
export interface LocalEmbedderOptions {
    /**
     * HF model id. Defaults to `Xenova/all-MiniLM-L6-v2` (384-dim).
     * Other tested options:
     *   - `Xenova/bge-small-en-v1.5`     (384-dim, similar quality, EN only)
     *   - `Xenova/multilingual-e5-small` (384-dim, multilingual)
     * Set `ANVIL_MEMORY_EMBED_MODEL` env to override.
     */
    model?: string;
    /** Cache dir override. */
    cacheDir?: string;
}
export declare function createLocalEmbedder(opts?: LocalEmbedderOptions): Embedder;
/** Reset the cached pipeline. Used by tests; not exported via the barrel. */
export declare function _resetLocalEmbedder(): void;
//# sourceMappingURL=local-embedder.d.ts.map