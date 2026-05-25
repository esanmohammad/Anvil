/**
 * Ollama-backed embedder. Higher-quality (`bge-m3` is 1024-dim, trained
 * on a large corpus) but requires an external Ollama daemon.
 *
 * Used as the `'ollama'` provider in `memory-embedder.ts`'s chooser.
 */
import { getFetchPool } from '@esankhan3/anvil-agent-core';
export function createOllamaEmbedder(opts = {}) {
    const host = (opts.ollamaHost ?? process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/+$/, '');
    const model = opts.model ?? process.env.ANVIL_MEMORY_EMBED_MODEL ?? 'bge-m3';
    const timeoutMs = opts.timeoutMs ?? 8_000;
    return async (text) => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
            const res = await fetch(`${host}/api/embeddings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ model, prompt: text }),
                signal: ctrl.signal,
                // @ts-expect-error — undici dispatcher accepted by Node fetch at runtime
                dispatcher: getFetchPool('ollama'),
            });
            if (!res.ok) {
                throw new Error(`ollama embed ${res.status}`);
            }
            const json = (await res.json());
            if (!json.embedding || json.embedding.length === 0) {
                throw new Error('ollama returned no embedding');
            }
            return json.embedding;
        }
        finally {
            clearTimeout(t);
        }
    };
}
/**
 * Quick liveness probe — returns true if Ollama is reachable at the
 * configured host. Used by the embedder chooser to default to Ollama
 * when available and fall back to the local model otherwise.
 *
 * 1.5s timeout so a missing daemon doesn't gate dashboard boot.
 */
export async function probeOllamaReachable(host = (process.env.OLLAMA_HOST ?? 'http://localhost:11434').replace(/\/+$/, '')) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    try {
        const res = await fetch(`${host}/api/tags`, {
            signal: ctrl.signal,
            // @ts-expect-error — undici dispatcher accepted by Node fetch at runtime
            dispatcher: getFetchPool('ollama'),
        });
        return res.ok;
    }
    catch {
        return false;
    }
    finally {
        clearTimeout(t);
    }
}
//# sourceMappingURL=ollama-embedder.js.map