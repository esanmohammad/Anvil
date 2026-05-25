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
// Module-scope cache: the pipeline is heavy to construct (~5-10s cold),
// so we share one instance across all calls in the process.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pipelinePromise = null;
function getPipeline(model, cacheDir) {
    if (!pipelinePromise) {
        pipelinePromise = (async () => {
            // eslint-disable-next-line @typescript-eslint/naming-convention
            const transformers = await import('@huggingface/transformers');
            if (cacheDir && transformers.env) {
                transformers.env.cacheDir = cacheDir;
            }
            return transformers.pipeline('feature-extraction', model, { cache_dir: cacheDir });
        })().catch((err) => {
            // Reset on failure so the next call can retry instead of returning a
            // permanently-rejected promise (e.g., transient HF download error).
            pipelinePromise = null;
            throw err;
        });
    }
    return pipelinePromise;
}
export function createLocalEmbedder(opts = {}) {
    const model = opts.model ?? process.env.ANVIL_MEMORY_EMBED_MODEL ?? 'Xenova/all-MiniLM-L6-v2';
    const cacheDir = opts.cacheDir ?? process.env.ANVIL_MEMORY_EMBED_CACHE_DIR;
    return async (text) => {
        const pipe = await getPipeline(model, cacheDir);
        // `pooling: 'mean'` averages token vectors → one vector per sentence.
        // `normalize: true` L2-normalizes the result so cosine == dot product,
        // which matches LanceDB's default distance metric.
        const result = await pipe(text, { pooling: 'mean', normalize: true });
        // `data` is a Float32Array on Node — convert to plain number[] for
        // LanceDB's serializer and for JSON-shape parity with the Ollama path.
        return Array.from(result.data);
    };
}
/** Reset the cached pipeline. Used by tests; not exported via the barrel. */
export function _resetLocalEmbedder() {
    pipelinePromise = null;
}
//# sourceMappingURL=local-embedder.js.map