/**
 * Phase 7 — deterministic local prompt embedding for the checkpoint
 * similarity cache.
 *
 * The exact-hash checkpoint cache (`checkpoint-store.ts`) only hits when the
 * prompt is byte-identical. Interactive iteration on a feature flips that
 * to a near-100% miss rate: a one-word edit ("Add the user's email" →
 * "Also add the user's email") lands on a different hash and re-runs the
 * stage. Phase 7 fixes that by embedding prompts and falling through to a
 * cosine-similarity match when the exact lookup misses.
 *
 * ── Why hashed character n-grams ────────────────────────────────────────
 *
 * Anything more semantic (Codestral / Voyage / Ollama embeddings) would
 * either bring an HTTP dependency into the dashboard server or push stage 1
 * latency past the 500ms acceptance bar. We don't actually need semantic
 * similarity here — we need *near-edit* similarity, where small textual
 * deltas map to small vector deltas.
 *
 * Hashed character trigrams (FNV-1a → mod 256) deliver exactly that:
 *   - identical prompts → cosine 1.0
 *   - one-word edit on a 200-char prompt → cosine ≈ 0.98–0.99
 *   - whole rewrite → cosine well below 0.95
 *
 * That makes the plan's stated threshold (0.95) a comfortable cutoff.
 *
 * ── Determinism ─────────────────────────────────────────────────────────
 *
 * No randomness, no time. Same prompt always maps to the same vector across
 * processes / hosts / restarts. The vectors are persisted to disk by
 * `checkpoint-similarity-index.ts` and re-loaded on startup; if we ever
 * change the embedding (DIM, NGRAM, lowercasing, hash function) we bump the
 * `EMBEDDING_VERSION` and the index format invalidates.
 */

const DIM = 256;
const NGRAM = 3;

/**
 * Bumped only when the embedding shape changes (DIM, NGRAM, hash, or
 * normalization). Persisted alongside the index so loaders can drop entries
 * from an older shape rather than mixing incompatible vectors.
 */
export const EMBEDDING_VERSION = 1;

/** FNV-1a 32-bit hash. Stable across Node versions. */
function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

/**
 * Embed a prompt into a fixed-DIM l2-normalized vector via hashed character
 * trigrams. Lowercases input so trivial casing changes don't perturb the
 * vector.
 *
 * Edge cases:
 *   - empty / very short prompt: returns the zero vector (no trigrams to bin)
 *   - non-string / nullish input: caller's responsibility — TypeScript should
 *     rule this out, and a hot path doesn't need a runtime check.
 */
export function embedPrompt(prompt: string): number[] {
  const v = new Array<number>(DIM).fill(0);
  const text = prompt.toLowerCase();
  if (text.length < NGRAM) return v;

  for (let i = 0; i + NGRAM <= text.length; i++) {
    const tri = text.slice(i, i + NGRAM);
    const bin = fnv1a(tri) % DIM;
    v[bin] += 1;
  }

  // l2-normalize so cosine reduces to a dot product.
  let sum = 0;
  for (let i = 0; i < DIM; i++) sum += v[i] * v[i];
  if (sum === 0) return v;
  const norm = Math.sqrt(sum);
  for (let i = 0; i < DIM; i++) v[i] /= norm;
  return v;
}

/**
 * Cosine similarity for two vectors. Both are assumed l2-normalized (i.e.
 * `embedPrompt` output) so cosine reduces to a dot product. Returns 0 for
 * mismatched dims rather than throwing — a malformed persisted index
 * shouldn't crash the dashboard.
 */
export function cosine(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}
