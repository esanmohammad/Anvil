/**
 * CI Triage Phase 2 — rank tests by AST-graph reachability.
 *
 * Given a set of changed symbols (from a PR diff) and a set of per-repo AST
 * graphs (from the knowledge-base cache), walk the *inverse* import/call graph
 * from each changed symbol up to `maxDistance` hops and collect any node that
 * looks like a test file (filename pattern match). The result is a list of
 * tests ranked by graph distance (ascending — closer = more likely to be
 * affected) with ties broken by how many distinct changed symbols reach it
 * (descending — more matches = more relevant).
 *
 * ── Graph shape ─────────────────────────────────────────────────────────────
 *
 * The `knowledge/ast-graph-builder` emits `GraphifyOutput` objects with:
 *   { nodes: Array<{ id, label?, type?, file? }>,
 *     links: Array<{ source, target, type?, confidence? }> }
 *
 * We accept `unknown` for the graph shape (the KB output format evolves) and
 * defensively coerce to the minimal fields we need. Nodes can be referenced
 * by `id`; a node is a "symbol" if it has a `file` field. We accept both
 * `.links` and `.edges` naming since different knowledge-base versions use
 * both.
 *
 * ── Inverse graph ───────────────────────────────────────────────────────────
 *
 * Imports in source code point FROM consumer TO producer (`a.ts` imports `b.ts`
 * → edge source=a, target=b). To find callers of a changed symbol we walk
 * edges *in reverse*: given changed node `B`, any edge `(A → B)` tells us `A`
 * depends on `B`. We iterate by BFS, recording the distance.
 *
 * ── Test file detection ─────────────────────────────────────────────────────
 *
 * A node is considered a test if its `file` (or `id` if no file field) matches
 * one of the `testFilePatterns`. We do simple glob-to-regex conversion (only
 * `*`, `**`, `?`) — full glob semantics are not required.
 */

// ── Public types ───────────────────────────────────────────────────────────

export interface ChangedSymbol {
  repoName: string;
  filePath: string;
  symbol?: string;
  changeKind: 'added' | 'modified' | 'removed';
}

export interface RankedTest {
  testFile: string;
  testName?: string;
  distance: number;
  matchedSymbols: string[];
  repoName: string;
}

export interface RelevanceResult {
  totalTests: number;
  rankedRelevant: RankedTest[];
  estimatedRuntimeMs: number;
  estimatedSavings: string;
}

export interface RankRelevantTestsInput {
  changedSymbols: ChangedSymbol[];
  repoGraphs: Record<string, unknown>;
  maxDistance?: number;
  testFilePatterns?: string[];
}

// ── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_MAX_DISTANCE = 3;

const DEFAULT_TEST_PATTERNS: string[] = [
  '**/*.test.*',
  '**/*.spec.*',
  '**/__tests__/**/*.*',
];

/**
 * Per-test runtime assumption used by the estimator. Real values will come
 * from the learned-durations store once wired in; for now we use a
 * conservative fixed 500ms/test (matches the team's rough average).
 */
const DEFAULT_PER_TEST_MS = 500;

// ── Internal types ─────────────────────────────────────────────────────────

interface MiniNode {
  id: string;
  file: string;
  label?: string;
  type?: string;
}

interface MiniEdge {
  source: string;
  target: string;
}

interface MiniGraph {
  nodes: Map<string, MiniNode>;
  outgoing: Map<string, string[]>;  // source → targets
  incoming: Map<string, string[]>;  // target → sources (the inverse graph)
}

// ── Graph coercion ─────────────────────────────────────────────────────────

function isRecord(x: unknown): x is Record<string, unknown> {
  return !!x && typeof x === 'object' && !Array.isArray(x);
}

function extractNodes(raw: unknown): MiniNode[] {
  if (!isRecord(raw)) return [];
  const arr = raw.nodes;
  if (!Array.isArray(arr)) return [];
  const out: MiniNode[] = [];
  for (const n of arr) {
    if (!isRecord(n)) continue;
    const id = typeof n.id === 'string' ? n.id : null;
    if (!id) continue;
    const file = typeof n.file === 'string'
      ? n.file
      : (typeof n.filePath === 'string' ? n.filePath : '');
    const label = typeof n.label === 'string' ? n.label : undefined;
    const type = typeof n.type === 'string' ? n.type : undefined;
    out.push({ id, file, label, type });
  }
  return out;
}

function extractEdges(raw: unknown): MiniEdge[] {
  if (!isRecord(raw)) return [];
  const links = Array.isArray(raw.links) ? raw.links
    : (Array.isArray(raw.edges) ? raw.edges : []);
  const out: MiniEdge[] = [];
  for (const e of links) {
    if (!isRecord(e)) continue;
    const src = typeof e.source === 'string' ? e.source : null;
    const tgt = typeof e.target === 'string' ? e.target : null;
    if (!src || !tgt) continue;
    out.push({ source: src, target: tgt });
  }
  return out;
}

function buildMiniGraph(raw: unknown): MiniGraph {
  const nodes = new Map<string, MiniNode>();
  for (const n of extractNodes(raw)) nodes.set(n.id, n);

  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const e of extractEdges(raw)) {
    let o = outgoing.get(e.source);
    if (!o) { o = []; outgoing.set(e.source, o); }
    o.push(e.target);

    let i = incoming.get(e.target);
    if (!i) { i = []; incoming.set(e.target, i); }
    i.push(e.source);
  }
  return { nodes, outgoing, incoming };
}

// ── Pattern matching ───────────────────────────────────────────────────────

/**
 * Minimal glob→RegExp conversion supporting `**`, `*`, and `?`. Anchors both
 * ends so callers can pass `**\/x.ts` to match any segment-suffix.
 */
function globToRegExp(glob: string): RegExp {
  let out = '';
  let i = 0;
  while (i < glob.length) {
    const ch = glob.charAt(i);
    if (ch === '*' && glob.charAt(i + 1) === '*') {
      out += '.*';
      i += 2;
      if (glob.charAt(i) === '/') i += 1; // consume '/' after '**'
      continue;
    }
    if (ch === '*') {
      out += '[^/]*';
      i += 1;
      continue;
    }
    if (ch === '?') {
      out += '[^/]';
      i += 1;
      continue;
    }
    if ('.+^$()|{}[]\\'.indexOf(ch) >= 0) {
      out += '\\' + ch;
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return new RegExp('^' + out + '$');
}

function compilePatterns(patterns: string[]): RegExp[] {
  return patterns.map(globToRegExp);
}

function pathMatchesAny(path: string, patterns: RegExp[]): boolean {
  // Try the path and also the basename so `**/*.test.*` hits bare filenames.
  const base = path.split('/').pop() ?? path;
  for (const re of patterns) {
    if (re.test(path)) return true;
    if (re.test(base)) return true;
  }
  return false;
}

// ── Seed resolution ────────────────────────────────────────────────────────

/**
 * Map a ChangedSymbol to zero-or-more node ids in the graph. A change with
 * an explicit `symbol` is resolved by matching both `file + label` and by
 * id substring. A file-level change (no `symbol`) expands to every node in
 * that file.
 */
function findSeedIds(graph: MiniGraph, change: ChangedSymbol): string[] {
  const out: string[] = [];
  for (const node of graph.nodes.values()) {
    if (node.file !== change.filePath) continue;
    if (!change.symbol) {
      out.push(node.id);
      continue;
    }
    if (node.label === change.symbol) {
      out.push(node.id);
      continue;
    }
    // Fallback: id often looks like `<file>::<symbol>` — substring check.
    if (node.id.endsWith('::' + change.symbol) || node.id.endsWith(':' + change.symbol)) {
      out.push(node.id);
    }
  }
  return out;
}

// ── BFS over the inverse graph ─────────────────────────────────────────────

interface Visit {
  distance: number;
  seeds: Set<string>;   // the changed-symbol keys that reached this node
}

function bfsInverse(
  graph: MiniGraph,
  seedId: string,
  seedKey: string,
  maxDistance: number,
  visits: Map<string, Visit>,
): void {
  const queue: Array<{ id: string; d: number }> = [{ id: seedId, d: 0 }];
  const localSeen = new Set<string>([seedId]);
  while (queue.length > 0) {
    const { id, d } = queue.shift()!;
    let rec = visits.get(id);
    if (!rec) {
      rec = { distance: d, seeds: new Set() };
      visits.set(id, rec);
    } else if (d < rec.distance) {
      rec.distance = d;
    }
    rec.seeds.add(seedKey);

    if (d >= maxDistance) continue;
    const preds = graph.incoming.get(id) ?? [];
    for (const p of preds) {
      if (localSeen.has(p)) continue;
      localSeen.add(p);
      queue.push({ id: p, d: d + 1 });
    }
  }
}

// ── Public entry ───────────────────────────────────────────────────────────

export function rankRelevantTests(input: RankRelevantTestsInput): RelevanceResult {
  const maxDistance = input.maxDistance ?? DEFAULT_MAX_DISTANCE;
  const patterns = compilePatterns(input.testFilePatterns ?? DEFAULT_TEST_PATTERNS);

  const rankedByRepo: RankedTest[] = [];
  let totalTests = 0;

  for (const [repoName, rawGraph] of Object.entries(input.repoGraphs)) {
    const graph = buildMiniGraph(rawGraph);

    // Count every test file in this repo (the "denominator" for savings).
    const testNodeIds = new Set<string>();
    for (const node of graph.nodes.values()) {
      if (pathMatchesAny(node.file || node.id, patterns)) {
        testNodeIds.add(node.id);
      }
    }
    // Dedupe test FILES (multiple symbols per file shouldn't inflate the count).
    const testFileSet = new Set<string>();
    for (const id of testNodeIds) {
      const n = graph.nodes.get(id);
      if (n) testFileSet.add(n.file || n.id);
    }
    totalTests += testFileSet.size;

    // Walk the inverse graph from every changed symbol rooted in this repo.
    const visits = new Map<string, Visit>();
    const changesInRepo = input.changedSymbols.filter((c) => c.repoName === repoName);
    for (const change of changesInRepo) {
      const seedKey = change.symbol
        ? `${change.filePath}::${change.symbol}`
        : change.filePath;
      const seeds = findSeedIds(graph, change);
      for (const seed of seeds) {
        bfsInverse(graph, seed, seedKey, maxDistance, visits);
      }
    }

    // Every visited node that IS a test file becomes a RankedTest.
    // Aggregate by file path — multiple symbols in one test file dedupe.
    const byFile = new Map<string, RankedTest>();
    for (const [nodeId, visit] of visits) {
      if (!testNodeIds.has(nodeId)) continue;
      if (visit.distance === 0) continue; // the seed itself is never "relevant"
      const node = graph.nodes.get(nodeId);
      if (!node) continue;
      const filePath = node.file || node.id;
      const existing = byFile.get(filePath);
      if (!existing) {
        byFile.set(filePath, {
          testFile: filePath,
          testName: node.label,
          distance: visit.distance,
          matchedSymbols: Array.from(visit.seeds),
          repoName,
        });
        continue;
      }
      // Keep the shortest distance and union the matched symbols.
      if (visit.distance < existing.distance) existing.distance = visit.distance;
      if (!existing.testName && node.label) existing.testName = node.label;
      const merged = new Set(existing.matchedSymbols);
      for (const s of visit.seeds) merged.add(s);
      existing.matchedSymbols = Array.from(merged);
    }

    for (const t of byFile.values()) rankedByRepo.push(t);
  }

  // Sort: distance ascending, then matchedSymbols.length descending (more
  // distinct changes reaching a test ⇒ higher relevance), then testFile asc
  // for stable output.
  rankedByRepo.sort((a, b) => {
    if (a.distance !== b.distance) return a.distance - b.distance;
    const ml = b.matchedSymbols.length - a.matchedSymbols.length;
    if (ml !== 0) return ml;
    return a.testFile.localeCompare(b.testFile);
  });

  const estimatedRuntimeMs = rankedByRepo.length * DEFAULT_PER_TEST_MS;
  const estimatedSavings = formatSavings(rankedByRepo.length, totalTests, estimatedRuntimeMs);

  return {
    totalTests,
    rankedRelevant: rankedByRepo,
    estimatedRuntimeMs,
    estimatedSavings,
  };
}

function formatSavings(ran: number, total: number, runtimeMs: number): string {
  if (total <= 0) {
    return `ran ${ran} of 0 tests; no graph data available`;
  }
  const pct = Math.round(((total - ran) / total) * 100);
  const runtimeLabel = fmtDuration(runtimeMs);
  return `ran ${ran} of ${total} tests; ${pct}% saved (est. ${runtimeLabel})`;
}

function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const secs = Math.round(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  const rem = secs % 60;
  return rem === 0 ? `${mins}m` : `${mins}m ${rem}s`;
}

/** Compute a stable hash-friendly key for an array of changed symbols. */
export function diffFingerprint(symbols: ChangedSymbol[]): string {
  const normalized = symbols
    .map((s) => `${s.repoName}|${s.filePath}|${s.symbol ?? ''}|${s.changeKind}`)
    .sort();
  return normalized.join('\n');
}
