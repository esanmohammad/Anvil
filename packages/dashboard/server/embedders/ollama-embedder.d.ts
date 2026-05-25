/**
 * Ollama-backed embedder. Higher-quality (`bge-m3` is 1024-dim, trained
 * on a large corpus) but requires an external Ollama daemon.
 *
 * Used as the `'ollama'` provider in `memory-embedder.ts`'s chooser.
 */
import type { Embedder } from '@esankhan3/anvil-memory-core';
export interface OllamaEmbedderOptions {
    ollamaHost?: string;
    model?: string;
    timeoutMs?: number;
}
export declare function createOllamaEmbedder(opts?: OllamaEmbedderOptions): Embedder;
/**
 * Quick liveness probe — returns true if Ollama is reachable at the
 * configured host. Used by the embedder chooser to default to Ollama
 * when available and fall back to the local model otherwise.
 *
 * 1.5s timeout so a missing daemon doesn't gate dashboard boot.
 */
export declare function probeOllamaReachable(host?: string): Promise<boolean>;
//# sourceMappingURL=ollama-embedder.d.ts.map