/**
 * Review KB Context — Phase R5 of the review pipeline.
 *
 * Pre-computes AST-graph impact per changed symbol so review personas receive
 * structured architectural context alongside the diff. Given a list of changed
 * files (with optional symbol names) and a per-repo map of AST graphs (the
 * `graph.json` files written by `KnowledgeBaseManager`), resolves:
 *
 *   - callers:  edges pointing INTO the symbol (reverse-index lookup)
 *   - callees:  edges leaving the symbol
 *   - cross-repo consumers: callers that live in a different repo
 *   - isPublicApi: heuristic detection (index.* barrel OR `export` metadata)
 *   - rippleEstimate: coarse blast-radius bucket
 *
 * The module is pure — no I/O, no mutations, no globals. The caller loads
 * `graph.json` files from `~/.anvil/kb/<project>/<repo>/graph.json` and passes
 * them in as a `Record<repoName, unknown>` so this module can be tested
 * hermetically.
 */

// ── Public types ──────────────────────────────────────────────────────────

export interface SymbolImpact {
  symbol: string;
  filePath: string;
  repoName: string;
  callers: Array<{ file: string; line?: number; context?: string }>;
  callees: Array<{ file: string; line?: number; context?: string }>;
  crossRepoConsumers: Array<{ repoName: string; file: string }>;
  isPublicApi: boolean;
  rippleEstimate: 'small' | 'medium' | 'large';
}

export interface KbContextReport {
  changedSymbols: SymbolImpact[];
  orphans: Array<{ file: string; note: string }>;
}

// ── Internal narrowed graph shapes ────────────────────────────────────────

interface GraphNode {
  id: string;
  label?: string;
  file?: string;
  type?: string;
  exported?: boolean;
  isExport?: boolean;
}

interface GraphEdge {
  source: string;
  target: string;
  type?: string;
}

interface NormalizedGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  byId: Map<string, GraphNode>;
  byFile: Map<string, GraphNode[]>;
  byLabel: Map<string, GraphNode[]>;
  outgoing: Map<string, GraphEdge[]>;
  incoming: Map<string, GraphEdge[]>;
}

// ── Type guards ───────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function asBool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

function readNode(raw: unknown): GraphNode | null {
  if (!isRecord(raw)) return null;
  const id = asString(raw.id);
  if (!id) return null;
  return {
    id,
    label: asString(raw.label),
    file: asString(raw.file),
    type: asString(raw.type),
    exported: asBool(raw.exported),
    isExport: asBool(raw.isExport),
  };
}

function readEdge(raw: unknown): GraphEdge | null {
  if (!isRecord(raw)) return null;
  const src = asString(raw.source) ?? asString(raw.from);
  const tgt = asString(raw.target) ?? asString(raw.to);
  if (!src || !tgt) return null;
  return { source: src, target: tgt, type: asString(raw.type) ?? asString(raw.relation) };
}

function readEdgesArray(raw: unknown): unknown[] {
  if (!isRecord(raw)) return [];
  // Graph builders emit edges under either `links` (D3) or `edges`.
  if (Array.isArray(raw.links)) return raw.links;
  if (Array.isArray(raw.edges)) return raw.edges;
  return [];
}

function normalizeGraph(raw: unknown): NormalizedGraph {
  const empty: NormalizedGraph = {
    nodes: [],
    edges: [],
    byId: new Map(),
    byFile: new Map(),
    byLabel: new Map(),
    outgoing: new Map(),
    incoming: new Map(),
  };
  if (!isRecord(raw)) return empty;

  const rawNodes = Array.isArray(raw.nodes) ? raw.nodes : [];
  const nodes: GraphNode[] = [];
  for (const n of rawNodes) {
    const parsed = readNode(n);
    if (parsed) nodes.push(parsed);
  }

  const edges: GraphEdge[] = [];
  for (const e of readEdgesArray(raw)) {
    const parsed = readEdge(e);
    if (parsed) edges.push(parsed);
  }

  const byId = new Map<string, GraphNode>();
  const byFile = new Map<string, GraphNode[]>();
  const byLabel = new Map<string, GraphNode[]>();
  for (const n of nodes) {
    byId.set(n.id, n);
    if (n.file) {
      const list = byFile.get(n.file) ?? [];
      list.push(n);
      byFile.set(n.file, list);
    }
    if (n.label) {
      const list = byLabel.get(n.label) ?? [];
      list.push(n);
      byLabel.set(n.label, list);
    }
  }

  const outgoing = new Map<string, GraphEdge[]>();
  const incoming = new Map<string, GraphEdge[]>();
  for (const e of edges) {
    const out = outgoing.get(e.source) ?? [];
    out.push(e);
    outgoing.set(e.source, out);
    const inc = incoming.get(e.target) ?? [];
    inc.push(e);
    incoming.set(e.target, inc);
  }

  return { nodes, edges, byId, byFile, byLabel, outgoing, incoming };
}

// ── Edge classification ───────────────────────────────────────────────────
//
// "contains" edges link a module to the symbols it defines and are structural
// bookkeeping — they aren't real callers/callees. We exclude them so ripple
// estimates reflect actual code dependencies.

const STRUCTURAL_EDGE_TYPES = new Set(['contains']);

function isStructural(e: GraphEdge): boolean {
  return e.type ? STRUCTURAL_EDGE_TYPES.has(e.type) : false;
}

// ── Symbol resolution ─────────────────────────────────────────────────────

function resolveSymbolNode(
  graph: NormalizedGraph,
  filePath: string,
  symbol: string,
): GraphNode | null {
  // Graph IDs follow the convention "<filePath>::<symbol>".
  const qualified = `${filePath}::${symbol}`;
  const direct = graph.byId.get(qualified);
  if (direct) return direct;

  // Fallback: look up by label within the file's nodes.
  const fileNodes = graph.byFile.get(filePath) ?? [];
  for (const n of fileNodes) {
    if (n.label === symbol) return n;
  }

  // Last-resort: any node with that label (ambiguous, but better than nothing).
  const labelMatches = graph.byLabel.get(symbol) ?? [];
  if (labelMatches.length === 1) return labelMatches[0];

  return null;
}

// ── Public-API heuristic ──────────────────────────────────────────────────
//
// A symbol counts as "public API" if:
//  (a) its file is an `index.*` barrel (callers import through it), OR
//  (b) the graph builder marked the node as exported.
// Also: if any node in the symbol's file is an `index.*` re-export of the
// symbol, we treat it as public.

function isIndexBarrel(file: string): boolean {
  const base = file.split('/').pop() ?? '';
  return /^index\.[a-zA-Z0-9]+$/.test(base);
}

function detectPublicApi(
  graph: NormalizedGraph,
  node: GraphNode,
): boolean {
  if (node.exported === true || node.isExport === true) return true;
  if (node.file && isIndexBarrel(node.file)) return true;

  // Look for index barrels that reference this symbol.
  const incoming = graph.incoming.get(node.id) ?? [];
  for (const e of incoming) {
    const src = graph.byId.get(e.source);
    if (src?.file && isIndexBarrel(src.file)) return true;
  }
  return false;
}

// ── Ripple bucket ─────────────────────────────────────────────────────────
//
// Thresholds chosen so trivial utility calls (1-4 hits) don't inflate review
// attention, while anything >=20 surfaces as explicitly high-risk regardless
// of cross-repo fan-out. Cross-repo consumers count toward the total because
// they imply coordinated deploys / contract compatibility.

function bucketRipple(hits: number): SymbolImpact['rippleEstimate'] {
  if (hits < 5) return 'small';
  if (hits < 20) return 'medium';
  return 'large';
}

// ── Main API ──────────────────────────────────────────────────────────────

export function computeKbContext(
  changedFiles: Array<{ repoName: string; filePath: string; addedSymbols?: string[] }>,
  repoGraphs: Record<string, unknown>,
): KbContextReport {
  const normalized = new Map<string, NormalizedGraph>();
  for (const [name, raw] of Object.entries(repoGraphs)) {
    normalized.set(name, normalizeGraph(raw));
  }

  const changedSymbols: SymbolImpact[] = [];
  const orphans: KbContextReport['orphans'] = [];

  for (const change of changedFiles) {
    const graph = normalized.get(change.repoName);
    if (!graph || graph.nodes.length === 0) {
      orphans.push({
        file: change.filePath,
        note: `Repo "${change.repoName}" has no indexed graph; skipping symbol resolution.`,
      });
      continue;
    }

    const symbols = change.addedSymbols && change.addedSymbols.length > 0
      ? change.addedSymbols
      : deriveSymbolsFromFile(graph, change.filePath);

    if (symbols.length === 0) {
      orphans.push({
        file: change.filePath,
        note: 'No symbols could be resolved from the graph for this file.',
      });
      continue;
    }

    for (const symbol of symbols) {
      const node = resolveSymbolNode(graph, change.filePath, symbol);
      if (!node) {
        orphans.push({
          file: change.filePath,
          note: `Symbol "${symbol}" not found in the graph for repo "${change.repoName}".`,
        });
        continue;
      }

      const callers = collectCallers(graph, node);
      const callees = collectCallees(graph, node);
      const crossRepoConsumers = collectCrossRepoConsumers(
        normalized,
        change.repoName,
        node,
      );
      const isPublicApi = detectPublicApi(graph, node);
      const hits = callers.length + crossRepoConsumers.length;

      changedSymbols.push({
        symbol,
        filePath: change.filePath,
        repoName: change.repoName,
        callers,
        callees,
        crossRepoConsumers,
        isPublicApi,
        rippleEstimate: bucketRipple(hits),
      });
    }
  }

  return { changedSymbols, orphans };
}

// ── Helpers for caller/callee extraction ──────────────────────────────────

function deriveSymbolsFromFile(graph: NormalizedGraph, filePath: string): string[] {
  const out: string[] = [];
  const nodes = graph.byFile.get(filePath) ?? [];
  for (const n of nodes) {
    // Skip the module node itself (id === filePath); we want the symbols it
    // contains.
    if (n.id === filePath) continue;
    if (n.type === 'module' || n.type === 'package') continue;
    if (n.label) out.push(n.label);
  }
  return out;
}

function collectCallers(
  graph: NormalizedGraph,
  node: GraphNode,
): SymbolImpact['callers'] {
  const edges = graph.incoming.get(node.id) ?? [];
  const out: SymbolImpact['callers'] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (isStructural(e)) continue;
    const src = graph.byId.get(e.source);
    if (!src) continue;
    const file = src.file ?? src.id;
    const key = `${file}:${src.label ?? src.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file, context: src.label ?? src.id });
  }
  return out;
}

function collectCallees(
  graph: NormalizedGraph,
  node: GraphNode,
): SymbolImpact['callees'] {
  const edges = graph.outgoing.get(node.id) ?? [];
  const out: SymbolImpact['callees'] = [];
  const seen = new Set<string>();
  for (const e of edges) {
    if (isStructural(e)) continue;
    const tgt = graph.byId.get(e.target);
    if (!tgt) continue;
    const file = tgt.file ?? tgt.id;
    const key = `${file}:${tgt.label ?? tgt.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ file, context: tgt.label ?? tgt.id });
  }
  return out;
}

function collectCrossRepoConsumers(
  allGraphs: Map<string, NormalizedGraph>,
  ownerRepo: string,
  node: GraphNode,
): SymbolImpact['crossRepoConsumers'] {
  const out: SymbolImpact['crossRepoConsumers'] = [];
  const seen = new Set<string>();
  const needles = [node.id, node.label].filter((s): s is string => typeof s === 'string' && s.length > 0);

  for (const [repoName, graph] of allGraphs) {
    if (repoName === ownerRepo) continue;
    // Look for edges whose target matches a symbol name or for nodes that
    // appear to import the symbol by label.
    for (const e of graph.edges) {
      if (needles.some((n) => e.target === n || e.target.endsWith(`::${n}`))) {
        const src = graph.byId.get(e.source);
        const file = src?.file ?? e.source;
        const key = `${repoName}:${file}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ repoName, file });
      }
    }
  }
  return out;
}
