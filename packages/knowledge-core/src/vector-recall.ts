/**
 * P1d — IVF_PQ recall gate (ADR §5.5, O-4).
 *
 * The IVF_PQ index (P1c) trades exact recall for IO so an S3-backed query reads
 * only the probed partitions. This measures how much recall that costs:
 * recall@k = |approx_topk ∩ exact_topk| / k, averaged over a query set, where
 * the exact baseline is the SAME table's flat scan (`bypassVectorIndex`) — a
 * true apples-to-apples comparison, no parallel store. CI asserts the mean stays
 * above the SLO (≥ 0.98), so a regression that tanks recall (e.g. nprobes /
 * refineFactor not threaded, or numSubVectors misconfigured) fails the build.
 *
 * `rag-evaluator.ts` is intentionally NOT used here — it judges LLM *answer*
 * quality, a different axis. This is a pure vector-recall measurement.
 */

/** The two primitives the gate needs — structural, so it doesn't widen the
 *  VectorStorePort (the exact/bypass baseline is LanceDB-specific). */
export interface RecallProbe {
  vectorSearchIds(queryEmbedding: number[], k: number, nprobes?: number): Promise<string[]>;
  vectorSearchExactIds(queryEmbedding: number[], k: number): Promise<string[]>;
}

export interface RecallReport {
  k: number;
  queries: number;
  meanRecall: number;
  minRecall: number;
}

/** Mean (and worst-case) recall@k of the approximate index vs the exact flat
 *  baseline over `queries`. */
export async function measureRecallAtK(
  store: RecallProbe,
  queries: number[][],
  k: number,
): Promise<RecallReport> {
  let sum = 0;
  let min = 1;
  for (const q of queries) {
    const approx = new Set(await store.vectorSearchIds(q, k));
    const exact = await store.vectorSearchExactIds(q, k);
    const hit = exact.filter((id) => approx.has(id)).length;
    const recall = exact.length > 0 ? hit / exact.length : 1;
    sum += recall;
    if (recall < min) min = recall;
  }
  const n = queries.length;
  return { k, queries: n, meanRecall: n > 0 ? sum / n : 1, minRecall: n > 0 ? min : 1 };
}

/** The fewest IVF probes whose mean recall@k over `queries` reaches `target`
 *  (recall rises with probes, so a binary search over 1..maxNprobes). The
 *  exact baseline is computed once per query. When even `maxNprobes` misses
 *  the target (quantization loss), returns `maxNprobes` with its recall. */
export async function calibrateNprobes(
  store: RecallProbe,
  queries: number[][],
  opts: { k: number; target: number; maxNprobes: number },
): Promise<{ nprobes: number; recall: number }> {
  const exact: string[][] = [];
  for (const q of queries) exact.push(await store.vectorSearchExactIds(q, opts.k));
  const recallAt = async (nprobes: number): Promise<number> => {
    let sum = 0;
    for (let i = 0; i < queries.length; i++) {
      const approx = new Set(await store.vectorSearchIds(queries[i], opts.k, nprobes));
      sum += exact[i].length > 0 ? exact[i].filter((id) => approx.has(id)).length / exact[i].length : 1;
    }
    return queries.length > 0 ? sum / queries.length : 1;
  };
  let best = { nprobes: opts.maxNprobes, recall: await recallAt(opts.maxNprobes) };
  if (best.recall < opts.target) return best;
  let lo = 1;
  let hi = opts.maxNprobes;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    const recall = await recallAt(mid);
    if (recall >= opts.target) { hi = mid; best = { nprobes: mid, recall }; } else lo = mid + 1;
  }
  return best;
}
