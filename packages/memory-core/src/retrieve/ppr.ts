/**
 * Personalized PageRank for multi-hop memory retrieval (Phase 9 — ADR §M2).
 *
 * Pure-TS power iteration over a directed weighted graph. Used to surface
 * memories that are "related-via-N-hops" to a small set of LLM-vetted
 * seed nodes — the HippoRAG 2 pattern, ~10–30× cheaper than iterative
 * RAG while preserving multi-hop recall.
 *
 * The math is a direct transcription of the standard formulation:
 *
 *     score = (1 - α) · personalization + α · normalized(Wᵀ · score)
 *
 * with α = damping factor (default 0.85). Iteration stops when the
 * L1 delta drops below `epsilon` (default 1e-6) or after `maxIterations`
 * (default 50). All three knobs are caller-overridable.
 */

export interface PprNeighbor {
  target: string;
  weight: number;
}

export type PprAdjacency = Map<string, PprNeighbor[]>;

export interface PprOptions {
  /** α — probability of following an edge (vs teleporting back to a seed). */
  dampingFactor?: number;
  /** Cap on iterations; protects against ill-conditioned graphs. */
  maxIterations?: number;
  /** L1 convergence threshold. */
  epsilon?: number;
}

export interface PprResult {
  /** node id → final PPR score. */
  scores: Map<string, number>;
  /** Iterations actually run (≤ maxIterations). */
  iterations: number;
  /** Whether convergence was reached. */
  converged: boolean;
}

export function personalizedPageRank(
  adjacency: PprAdjacency,
  seeds: Map<string, number>,
  opts: PprOptions = {},
): PprResult {
  const damping = opts.dampingFactor ?? 0.85;
  // Theoretical convergence rate is geometric with ratio α; for α=0.85
  // and ε=1e-6 the worst-case iteration count is ≈ log(ε)/log(α) ≈ 86.
  // Default 100 keeps small-graph chains comfortably under the cap.
  const maxIterations = opts.maxIterations ?? 100;
  const epsilon = opts.epsilon ?? 1e-6;

  // Collect every node (sources + targets reachable in 1 hop).
  const nodes = new Set<string>();
  for (const [src, neighbors] of adjacency.entries()) {
    nodes.add(src);
    for (const { target } of neighbors) nodes.add(target);
  }
  for (const id of seeds.keys()) nodes.add(id);

  if (nodes.size === 0) {
    return { scores: new Map(), iterations: 0, converged: true };
  }

  // Normalize personalization vector (seeds) to sum to 1.
  const seedSum = Array.from(seeds.values()).reduce((s, v) => s + v, 0);
  const personalization = new Map<string, number>();
  if (seedSum > 0) {
    for (const [id, w] of seeds.entries()) {
      personalization.set(id, w / seedSum);
    }
  } else {
    // Fallback: uniform over all nodes if caller supplied no seeds.
    const u = 1 / nodes.size;
    for (const id of nodes) personalization.set(id, u);
  }

  // Pre-compute outgoing weight sums for every source — needed to
  // normalize edges so each row of the transition matrix sums to 1.
  const outWeight = new Map<string, number>();
  for (const [src, neighbors] of adjacency.entries()) {
    let sum = 0;
    for (const { weight } of neighbors) sum += Math.max(0, weight);
    outWeight.set(src, sum);
  }

  // Initial score = personalization vector (zeros for non-seeds).
  let scores = new Map<string, number>();
  for (const id of nodes) {
    scores.set(id, personalization.get(id) ?? 0);
  }

  let iter = 0;
  let converged = false;
  for (; iter < maxIterations; iter++) {
    const next = new Map<string, number>();

    // Teleportation term: (1 - α) · personalization
    for (const id of nodes) {
      next.set(id, (1 - damping) * (personalization.get(id) ?? 0));
    }

    // Diffusion term: α · Σ score(u) · transition(u → v)
    for (const [src, neighbors] of adjacency.entries()) {
      const srcScore = scores.get(src) ?? 0;
      const totalOut = outWeight.get(src) ?? 0;
      if (srcScore === 0 || totalOut === 0) continue;
      for (const { target, weight } of neighbors) {
        const w = Math.max(0, weight);
        if (w === 0) continue;
        const flow = damping * srcScore * (w / totalOut);
        next.set(target, (next.get(target) ?? 0) + flow);
      }
    }

    // Dangling mass: nodes with no outgoing edges leak score back to
    // the personalization vector to keep the total mass at 1.
    let dangling = 0;
    for (const id of nodes) {
      const out = outWeight.get(id) ?? 0;
      if (out === 0) dangling += scores.get(id) ?? 0;
    }
    if (dangling > 0) {
      for (const id of nodes) {
        next.set(
          id,
          (next.get(id) ?? 0) + damping * dangling * (personalization.get(id) ?? 0),
        );
      }
    }

    // L1 delta vs previous iteration.
    let delta = 0;
    for (const id of nodes) {
      delta += Math.abs((next.get(id) ?? 0) - (scores.get(id) ?? 0));
    }

    scores = next;
    if (delta < epsilon) {
      converged = true;
      iter += 1;
      break;
    }
  }

  return { scores, iterations: iter, converged };
}
