/**
 * Graph tools — AST graph queries, callers, dependencies, impact analysis,
 * call-path tracing, dead-code detection, and architecture overview.
 *
 * The cross-repo/system graph is served by knowledge-core's GraphStore
 * (SQLite-backed `system_graph.sqlite`, with a JSON fallback for older
 * indexes) — see knowledge-core/src/graph-store.ts. Tools query slices, so
 * org-scale graphs (900k+ nodes) no longer bust V8's string limit on read.
 * Per-repo tools (`get_repo_graph`, `find_dead_code`) still read the per-repo
 * `<KB>/<repo>/graph.json`. Node key convention: `repo::filePath::entity`.
 */

import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { ServerContext } from '../server.js';
import {
  getBlobStore,
  getGraphStore,
  getRetriever,
  findChunksInProject,
  loadAllProfiles,
  loadProfile,
  getAllChanges,
  getChangedFilesList,
  SYMMETRIC_EDGE_TYPES,
} from '@esankhan3/anvil-knowledge-core';
import { resolvedKnowledgeConfig } from '../core/env-config.js';
import type { GraphEdge, GraphStore, GraphDirection } from '@esankhan3/anvil-knowledge-core';
import { missingProfileText } from './profile.js';
import { toolError, toolText, validateArgs, type InputSchema, type ToolResult } from './validate.js';

const repoOf = (key: string): string => key.split('::')[0] ?? '';
const fileOf = (key: string): string => key.split('::')[1] ?? '';

// ---------------------------------------------------------------------------
// Call-path traversal — BFS over neighbors fetched lazily from the store
// (cached per traversal), so only touched nodes are read, never the whole graph.
// ---------------------------------------------------------------------------

function makeNeighborGetter(store: GraphStore, direction: GraphDirection, types?: string[]): (key: string) => string[] {
  const cache = new Map<string, string[]>();
  return (key) => {
    let v = cache.get(key);
    if (v === undefined) { v = store.neighborsOf(key, direction, types); cache.set(key, v); }
    return v;
  };
}

/** Shortest path (≥ 1 hop) from any `fromKeys` node to any `toKeys` node, ≤ maxDepth hops. */
function shortestPath(getNeighbors: (k: string) => string[], fromKeys: string[], toKeys: Set<string>, maxDepth: number): string[] | null {
  const visited = new Set<string>(fromKeys);
  let frontier: string[][] = fromKeys.map((k) => [k]);
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[][] = [];
    for (const path of frontier) {
      for (const nb of getNeighbors(path[path.length - 1])) {
        if (toKeys.has(nb) && nb !== path[0]) return [...path, nb];
        if (visited.has(nb)) continue;
        visited.add(nb);
        next.push([...path, nb]);
      }
    }
    frontier = next;
  }
  return null;
}

/** All nodes reachable from `fromKeys` within maxDepth, with their depth. */
function reachable(getNeighbors: (k: string) => string[], fromKeys: string[], maxDepth: number, cap = 50): Array<{ key: string; depth: number }> {
  const visited = new Set<string>(fromKeys);
  const out: Array<{ key: string; depth: number }> = [];
  let frontier = [...fromKeys];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const k of frontier) {
      for (const nb of getNeighbors(k)) {
        if (visited.has(nb)) continue;
        visited.add(nb);
        out.push({ key: nb, depth });
        next.push(nb);
        if (out.length >= cap) return out;
      }
    }
    frontier = next;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Dependents, file-level endpoints, changed line ranges, same-file references
// ---------------------------------------------------------------------------

/** Cross-repo endpoint nodes (routes, topics, tables … declared in a file):
 *  they hang off the file, not off any one entity in it. */
function endpointsIn(store: GraphStore, keys: string[]): string[] {
  const types = store.nodeTypes(keys);
  return keys.filter((k) => types.get(k) === 'external');
}

interface Hop { hop: number; edges: GraphEdge[]; total: number }
const HOP_EDGE_CAP = 1000;

/** Transitive dependents of `scope`, hop by hop. A dependent reached only
 *  through `fileLevel` nodes is file-level too (added to the set). */
function dependentHops(store: GraphStore, scope: string[], depth: number, fileLevel: Set<string>): { hops: Hop[]; repos: Set<string> } {
  const visited = new Set(scope);
  const repos = new Set<string>();
  const hops: Hop[] = [];
  let frontier = [...scope];
  for (let hop = 1; hop <= depth && frontier.length > 0; hop++) {
    const d = store.dependents(frontier, HOP_EDGE_CAP);
    const edges = d.edges.filter((e) => !visited.has(e.source));
    const direct = new Set<string>();
    const next: string[] = [];
    for (const e of edges) {
      repos.add(repoOf(e.source));
      if (!fileLevel.has(e.target)) direct.add(e.source);
      if (!visited.has(e.source)) { visited.add(e.source); next.push(e.source); }
    }
    for (const k of next) if (!direct.has(k)) fileLevel.add(k);
    hops.push({ hop, edges, total: d.total - (d.edges.length - edges.length) });
    frontier = next;
  }
  return { hops, repos };
}

function edgeLine(e: GraphEdge, fileLevel: Set<string>): string {
  const arrow = SYMMETRIC_EDGE_TYPES.has(e.type ?? '') ? '↔' : '→';
  return `- \`${e.source}\` ${arrow} \`${e.target}\` (${e.type ?? 'edge'})${e.evidence ? ` — ${e.evidence}` : ''}${fileLevel.has(e.target) ? ' [file-level]' : ''}`;
}

/** Indexed source of `files` in `repo` (their chunks' content), per file: the
 *  vector store first, else chunks.json for files it has nothing for (not
 *  embedded yet). */
async function indexedSources(project: string, repo: string, files: string[]): Promise<Map<string, string>> {
  const cfg = resolvedKnowledgeConfig();
  const parts = new Map<string, string[]>();
  try {
    const vs = (await getRetriever(project, cfg)).vectorStore;
    await Promise.all(files.map(async (f) => {
      const chunks = await vs.getChunksByFile(repo, f);
      if (chunks.length > 0) parts.set(f, chunks.map((c) => c.content));
    }));
  } catch { /* vector store unavailable — chunks.json below */ }
  const missing = new Set(files.filter((f) => !parts.has(f)));
  if (missing.size > 0 && (await getBlobStore(project, cfg).exists('chunks.json'))) {
    const found = await findChunksInProject(project, (c) => c.repoName === repo && missing.has(c.filePath), Number.POSITIVE_INFINITY, cfg);
    for (const c of found) {
      if (!parts.has(c.filePath)) parts.set(c.filePath, []);
      parts.get(c.filePath)!.push(c.content);
    }
  }
  return new Map([...parts].map(([f, cs]) => [f, cs.join('\n')]));
}

const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Occurrences of `name` as a whole identifier in `src`. */
function identifierCount(src: string, name: string): number {
  return src.match(new RegExp(`(?<![\\w$])${escapeRegex(name)}(?![\\w$])`, 'g'))?.length ?? 0;
}

const runGit = (repoPath: string, args: string[]): string => execFileSync('git', args, {
  cwd: repoPath, encoding: 'utf-8', maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'],
});

/** Old-side hunks (`-start,count`) of `git diff -U0 base` per file. */
function diffHunks(repoPath: string, baseSha: string, files: string[]): Map<string, Array<[number, number]>> {
  const out = new Map<string, Array<[number, number]>>();
  if (files.length === 0) return out;
  let file = '';
  for (const line of runGit(repoPath, ['diff', '-U0', '--no-color', '--no-ext-diff', baseSha, '--', ...files]).split('\n')) {
    if (line.startsWith('+++ ')) { file = line.slice(4).replace(/^b\//, ''); continue; }
    const m = /^@@ -(\d+)(?:,(\d+))? /.exec(line);
    if (m && file) {
      if (!out.has(file)) out.set(file, []);
      out.get(file)!.push([Number(m[1]), m[2] === undefined ? 1 : Number(m[2])]);
    }
  }
  return out;
}

interface LineRange { name: string; start: number; end: number }

/**
 * Line ranges of the graph entities `names` in `src` (the file at the diff
 * base). The graph stores no line numbers, so each declaration line of a name
 * opens a range that runs to the line before the next declaration — the
 * chunker's boundary rule. Keyword declarations (function, class, def, func,
 * fn, const, …) win; a name with none falls back to a method signature
 * (`[modifiers] [type] name(` on a line not ending in `;`).
 */
function declarationRanges(src: string, names: string[]): LineRange[] {
  const lines = src.split('\n');
  const starts: Array<{ name: string; line: number }> = [];
  for (const name of names) {
    const n = escapeRegex(name);
    const keyword = new RegExp(`\\b(?:function\\*?|class|interface|type|enum|struct|trait|impl|def|func|fn|const|let|var)\\s+(?:\\([^)]*\\)\\s*)?${n}(?![\\w$])`);
    const method = new RegExp(`^\\s*(?:(?:public|private|protected|internal|static|async|override|readonly|abstract|final|virtual|export|default)\\s+)*(?:[\\w$<>\\[\\],.?]+\\s+)?${n}\\s*(?:<[^>]*>)?\\(`);
    let found = lines.flatMap((l, i) => (keyword.test(l) ? [i + 1] : []));
    if (found.length === 0) found = lines.flatMap((l, i) => (method.test(l) && !l.trimEnd().endsWith(';') ? [i + 1] : []));
    for (const line of found) starts.push({ name, line });
  }
  starts.sort((a, b) => a.line - b.line);
  return starts.map((s, i) => ({ name: s.name, start: s.line, end: (starts[i + 1]?.line ?? lines.length + 1) - 1 }));
}

/** Entity names whose range overlaps a hunk; `fileLevel` when a hunk touches
 *  lines outside every range (imports, code before the first declaration). */
function touchedEntities(ranges: LineRange[], hunks: Array<[number, number]>): { names: Set<string>; fileLevel: boolean } {
  const names = new Set<string>();
  let fileLevel = false;
  for (const [start, count] of hunks) {
    // count 0 = pure insertion between `start` and `start + 1`.
    const hit = ranges.filter((r) => (count > 0 ? r.start <= start + count - 1 && r.end >= start : r.start <= start && r.end >= start + 1));
    if (hit.length === 0) fileLevel = true;
    for (const r of hit) names.add(r.name);
  }
  return { names, fileLevel };
}

// ---------------------------------------------------------------------------
// Tool descriptors
// ---------------------------------------------------------------------------

const RELATIONS = ['calls', 'imports', 'uses', 'type-ref', 'inherits', 'all'];
const relationsProp = (what: string) => ({
  type: 'array',
  items: { type: 'string', enum: RELATIONS },
  description: `Edge types to follow for ${what} (default ["calls"]): calls; imports (a file imports a file); uses (a file imports this symbol by name); type-ref; inherits; or "all" (every edge type except contains, cross-repo edges included)`,
});

/** `relations` → store edge-type filter; undefined = every type. */
function edgeTypes(args: Record<string, unknown>): string[] | undefined {
  const r = (args.relations as string[] | undefined) ?? ['calls'];
  return r.includes('all') ? undefined : r;
}

export function registerGraphTools() {
  return [
    {
      name: 'get_repo_graph',
      description: 'List a repo\'s AST graph: node and edge counts, entities (id + type) and edges (source → target + relation; `contains` omitted), each list capped by `limit`.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          repo: { type: 'string', minLength: 1, description: 'Repository name' },
          limit: { type: 'integer', minimum: 1, description: 'Max entities and max edges listed (default 50)' },
        },
        required: ['repo'],
      },
    },
    {
      name: 'get_cross_repo_edges',
      description: 'Connections between repos — HTTP routes, gRPC services, event/Kafka topics, database tables, Redis keys, S3 buckets, OpenAPI contracts, shared types / constants / env vars / npm deps — each with the evidence that produced it (route, topic, table, package). Same-repo workspace-package dependencies are listed in their own section. Up to 50 edges.',
      inputSchema: {
        type: 'object' as const,
        properties: { repo: { type: 'string', minLength: 1, description: 'Only edges involving this repo (optional)' } },
      },
    },
    {
      name: 'find_callers',
      description: 'Find the callers of a symbol — entities with a `calls` edge into it. The name is matched exactly (case-sensitive; a full "repo::file::entity" id works too) unless fuzzy:true. Imports, type references and inheritance are not calls: they are listed, by relation, only when requested via `relations`.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          function: { type: 'string', minLength: 1, description: 'Symbol name or qualified id (repo::file::entity)' },
          repo: { type: 'string', minLength: 1, description: 'Limit resolution to this repo (optional)' },
          fuzzy: { type: 'boolean', description: 'Case-insensitive substring match on symbol names instead of exact (default false)' },
          relations: relationsProp('callers'),
        },
        required: ['function'],
      },
    },
    {
      name: 'find_dependencies',
      description: 'Find what a symbol calls — targets of its `calls` edges. The name is matched exactly (case-sensitive; a full "repo::file::entity" id works too) unless fuzzy:true. Type references, inheritance and imports are listed, by relation, only when requested via `relations`.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          function: { type: 'string', minLength: 1, description: 'Symbol name or qualified id (repo::file::entity)' },
          repo: { type: 'string', minLength: 1, description: 'Limit resolution to this repo (optional)' },
          fuzzy: { type: 'boolean', description: 'Case-insensitive substring match on symbol names instead of exact (default false)' },
          relations: relationsProp('dependencies'),
        },
        required: ['function'],
      },
    },
    {
      name: 'impact_analysis',
      description: 'What is affected if a file or entity changes: everything that depends on it, transitively up to `depth` hops — over every relation (calls, imports, uses, type-refs, inheritance, cross-repo edges); shared-resource edges (topics, tables, Redis keys, buckets, shared types / constants / env vars / npm deps) count both ways. With `entity`, the cross-repo endpoints declared in the same file (routes, topics, tables …) are included and their dependents marked [file-level], since the graph can\'t tie them to one entity.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          file: { type: 'string', minLength: 1, description: 'File path (relative to repo root)' },
          entity: { type: 'string', minLength: 1, description: 'Entity name or full "repo::file::entity" id (optional — if omitted, analyzes everything in the file)' },
          repo: { type: 'string', minLength: 1, description: 'Repository name' },
          depth: { type: 'integer', minimum: 1, maximum: 5, description: 'Dependency hops to follow (default 2, max 5)' },
        },
        required: ['file', 'repo'],
      },
    },
    {
      name: 'trace_path',
      description: 'Trace a call chain across multiple hops. With "to", returns the shortest path (fewest hops, unweighted BFS) between two symbols; otherwise lists what is reachable, by depth (up to 50 nodes). Follows `calls` edges by default (`relations` for imports, type-refs, inheritance) and skips edges with confidence below 0.7. Names are matched exactly (a full "repo::file::entity" id works too) unless fuzzy:true.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          from: { type: 'string', minLength: 1, description: 'Starting symbol name or qualified id (repo::file::entity)' },
          to: { type: 'string', minLength: 1, description: 'Target symbol name or qualified id (optional — shortest path)' },
          repo: { type: 'string', minLength: 1, description: 'Limit resolution to this repo (optional)' },
          direction: { type: 'string', enum: ['callees', 'callers', 'both'], description: 'Traverse callees (what it calls), callers (who calls it), or both. Default callees.' },
          maxDepth: { type: 'integer', minimum: 1, maximum: 10, description: 'Max hops to traverse (default 4, max 10)' },
          fuzzy: { type: 'boolean', description: 'Case-insensitive substring match on symbol names instead of exact (default false)' },
          relations: relationsProp('the traversal'),
        },
        required: ['from'],
      },
    },
    {
      name: 'find_dead_code',
      description: 'List entities (functions, methods, classes, structs, enums, traits) with no incoming edge in the repo graph and no other mention of their name in their own file — likely dead code. Heuristic: exported APIs, reflection, and dynamic dispatch produce false positives.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          repo: { type: 'string', minLength: 1, description: 'Repository name' },
          limit: { type: 'integer', minimum: 1, description: 'Max results (default 50)' },
        },
        required: ['repo'],
      },
    },
    {
      name: 'get_architecture',
      description: 'High-level architecture overview of the project — repo roles, key flows, and how services connect. Built from the LLM-generated project graph and repo profiles.',
      inputSchema: {
        type: 'object' as const,
        properties: { repo: { type: 'string', minLength: 1, description: 'Drill into one repo profile (optional)' } },
      },
    },
    {
      name: 'search_graph',
      description: 'Structural search over the knowledge graph: filter nodes by name (case-insensitive regex over symbol names), type, file, and repo; rank by connectivity (degree). Answers "which functions matter most in this module" — a structural question search/grep can\'t.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', minLength: 1, description: 'Case-insensitive regex over symbol names (a plain substring works too). Files and cross-repo endpoints are skipped unless `type` is module / external. Optional.' },
          type: { type: 'string', minLength: 1, description: 'Node type: function | method | class | interface | type | const | struct | enum | trait | impl | package | module (a file) | external (a cross-repo endpoint). Optional.' },
          file: { type: 'string', minLength: 1, description: 'Case-insensitive file-path substring filter (optional)' },
          repo: { type: 'string', minLength: 1, description: 'Limit to this repo (optional)' },
          minDegree: { type: 'integer', minimum: 0, description: 'Only nodes with at least this many connections, `contains` excluded (default 0)' },
          limit: { type: 'integer', minimum: 1, description: 'Max results (default 50)' },
        },
      },
    },
    {
      name: 'detect_changes',
      description: 'Map a git diff to affected symbols and their dependents. Diffs the working tree against a base commit (default: the last-indexed SHA) and reports the entities whose line range at the base (from their declaration line to the next declaration) overlaps a changed hunk (every entity of an added or deleted file), the cross-repo endpoints of modified files (file-level), and what directly depends on them — a blast-radius / code-review tool. Requires a local repo (local/serve mode).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          repo: { type: 'string', minLength: 1, description: 'Repository name' },
          baseSha: { type: 'string', minLength: 1, description: 'Git base commit to diff against (default: last-indexed SHA)' },
          limit: { type: 'integer', minimum: 1, description: 'Max dependent edges to list (default 50)' },
        },
        required: ['repo'],
      },
    },
  ];
}

const SCHEMAS = new Map(registerGraphTools().map((t) => [t.name, t.inputSchema as InputSchema]));

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

export async function handleGraphTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ServerContext,
): Promise<ToolResult | null> {
  const schema = SCHEMAS.get(name);
  if (!schema) return null;
  const invalid = validateArgs(schema, args);
  if (invalid) return toolError(`${name}: ${invalid}`);
  const text = toolText;
  const NO_GRAPH = 'No system graph found. Build KB first.';

  try {
    const blobs = getBlobStore(ctx.projectName, resolvedKnowledgeConfig());

    if (name === 'get_repo_graph') {
      const repo = args.repo as string;
      const limit = (args.limit as number | undefined) ?? 50;
      const graph = await blobs.getJson<{ nodes?: any[]; links?: any[] }>(`${repo}/graph.json`);
      if (!graph) return toolError(`No graph found for repo "${repo}" — check the name with list_repos.`);
      const nodes = graph.nodes ?? [];
      const links = graph.links ?? [];
      const byType = new Map<string, number>();
      for (const l of links) byType.set(l.type ?? 'edge', (byType.get(l.type ?? 'edge') ?? 0) + 1);
      const listed = links.filter((l) => l.type !== 'contains');
      const more = (n: number) => (n > limit ? [`... and ${n - limit} more`] : []);
      return text([
        `# ${repo} AST Graph`,
        '',
        `- **Nodes:** ${nodes.length}`,
        `- **Edges:** ${links.length}${byType.size ? ` (${[...byType].map(([t, n]) => `${t} ${n}`).join(', ')})` : ''}`,
        '',
        '## Entities',
        ...nodes.slice(0, limit).map((n) => `- \`${n.id}\` (${n.type})`),
        ...more(nodes.length),
        '',
        `## Edges (${listed.length}, \`contains\` omitted)`,
        ...listed.slice(0, limit).map((l) => `- \`${l.source}\` → \`${l.target}\` (${l.type ?? 'edge'})`),
        ...more(listed.length),
      ].join('\n'));
    }

    if (name === 'get_cross_repo_edges') {
      const store = await getGraphStore(ctx.projectName, resolvedKnowledgeConfig());
      if (!store) return text(NO_GRAPH);
      const repo = args.repo as string | undefined;
      const { edges, total } = store.crossRepoEdges(repo, 50);
      if (total === 0) return text(repo ? `No cross-repo edges found for "${repo}"` : 'No cross-repo edges found');
      const between = edges.filter((e) => repoOf(e.source) !== repoOf(e.target));
      const within = edges.filter((e) => repoOf(e.source) === repoOf(e.target));
      const ev = (e: GraphEdge) => (e.evidence ? ` — ${e.evidence}` : '');
      const labels = store.labelsOf(within.flatMap((e) => [e.source, e.target]));
      const body = [
        `# Cross-Repo Edges${repo ? ` for ${repo}` : ''}`,
        '',
        `${total} edges found:`,
      ];
      if (between.length) {
        body.push('', `## Between repos (${between.length} listed)`);
        for (const e of between) {
          const arrow = SYMMETRIC_EDGE_TYPES.has(e.type ?? '') ? '↔' : '→';
          body.push(`- ${repoOf(e.source)} ${arrow} ${repoOf(e.target)} (${e.type ?? 'edge'})${ev(e)}  \`${fileOf(e.source)}\` ${arrow} \`${fileOf(e.target)}\``);
        }
      }
      if (within.length) {
        body.push('', `## Within a repo — workspace packages (${within.length} listed)`);
        for (const e of within) body.push(`- ${repoOf(e.source)}: ${labels.get(e.source)} → ${labels.get(e.target)} (${e.type ?? 'edge'})${ev(e)}`);
      }
      if (total > edges.length) body.push('', `... and ${total - edges.length} more`);
      return text(body.join('\n'));
    }

    if (name === 'find_callers' || name === 'find_dependencies') {
      const store = await getGraphStore(ctx.projectName, resolvedKnowledgeConfig());
      if (!store) return text('No system graph found.');
      const funcName = args.function as string;
      const repoFilter = args.repo as string | undefined;
      const fuzzy = args.fuzzy === true;
      const types = edgeTypes(args);
      const matched = store.resolveNodes(funcName, repoFilter, fuzzy);
      if (matched.length === 0) {
        return text(`No entity found matching "${funcName}"${repoFilter ? ` in ${repoFilter}` : ''}.${fuzzy ? '' : ' Try fuzzy:true for substring matching.'}`);
      }
      const keys = matched.map((m) => m.key);
      const fetch = (t?: string[]) => (name === 'find_callers' ? store.callers(keys, 30, t) : store.dependencies(keys, 30, t));
      const found = fetch(types);
      const noun = name === 'find_callers' ? 'callers' : 'dependencies';
      const title = `# ${name === 'find_callers' ? 'Callers of' : 'Dependencies of'} "${funcName}"`;
      const relLabel = types ? types.join(', ') : 'any relation';
      if (found.length === 0) {
        // Name the relations that do exist, so "no callers" isn't read as "unused".
        const other = new Map<string, number>();
        if (types) for (const o of fetch(undefined)) other.set(o.type, (other.get(o.type) ?? 0) + 1);
        const hint = other.size
          ? `\n\nOther relations: ${[...other].map(([t, n]) => `${t} ${n}`).join(', ')} — pass relations: ${JSON.stringify([...other.keys()])} to list them.`
          : '';
        return text(`${title}\n\nMatched ${matched.length} entit${matched.length === 1 ? 'y' : 'ies'}, but no ${noun} via ${relLabel}.${hint}`);
      }
      const byType = new Map<string, string[]>();
      for (const f of found) {
        if (!byType.has(f.type)) byType.set(f.type, []);
        byType.get(f.type)!.push(f.key);
      }
      const sections = [...byType].map(([t, ks]) => `## ${t} (${ks.length})\n${ks.map((k) => `- \`${k}\``).join('\n')}`).join('\n\n');
      return text(`${title}\n\n${found.length} found (${relLabel}):\n\n${sections}`);
    }

    if (name === 'impact_analysis') {
      const store = await getGraphStore(ctx.projectName, resolvedKnowledgeConfig());
      if (!store) return text('No system graph found.');
      const file = args.file as string;
      const repo = args.repo as string;
      const depth = (args.depth as number | undefined) ?? 2;
      let entity = args.entity as string | undefined;
      if (entity?.includes('::')) {
        const prefix = `${repo}::${file}::`;
        if (!entity.startsWith(prefix)) return toolError(`impact_analysis: entity id "${entity}" is not in ${repo}/${file} — pass a bare name or an id starting with "${prefix}".`);
        entity = entity.slice(prefix.length);
      }
      const fileKeys = store.nodesInFiles(repo, [file]);
      if (fileKeys.length === 0) return toolError(`No graph nodes for ${repo}/${file} — check the repo name and that the path is repo-relative and indexed.`);
      const scope = entity ? store.nodesInFiles(repo, [file], entity) : fileKeys;
      if (scope.length === 0) return toolError(`No entity "${entity}" in ${repo}/${file}.`);
      const endpoints = entity ? endpointsIn(store, fileKeys).filter((k) => !scope.includes(k)) : [];
      const fileLevel = new Set(endpoints);
      const { hops, repos } = dependentHops(store, [...scope, ...endpoints], depth, fileLevel);
      const total = hops.reduce((n, h) => n + h.total, 0);
      const body = [
        `# Impact Analysis: ${repo}/${file}${entity ? `::${entity}` : ''} (depth ${depth})`,
        '',
        `## Entities in scope: ${scope.length}`,
        ...scope.slice(0, 20).map((k) => `- \`${k}\``),
      ];
      if (endpoints.length) {
        body.push('', `## File-level endpoints: ${endpoints.length} (cross-repo endpoints in ${file}, not tied to ${entity})`, ...endpoints.slice(0, 20).map((k) => `- \`${k}\``));
      }
      body.push('', `## Dependents: ${total} edges from ${repos.size} repos`);
      for (const h of hops) {
        if (h.edges.length === 0) continue;
        body.push(`### Hop ${h.hop} (${h.total})`, ...h.edges.slice(0, 30).map((e) => edgeLine(e, fileLevel)));
        if (h.total > Math.min(h.edges.length, 30)) body.push(`... and ${h.total - Math.min(h.edges.length, 30)} more`);
      }
      body.push('', `## Affected repos: ${[...repos].join(', ') || 'none'}`);
      return text(body.join('\n'));
    }

    if (name === 'trace_path') {
      const store = await getGraphStore(ctx.projectName, resolvedKnowledgeConfig());
      if (!store) return text('No system graph found.');
      const from = args.from as string;
      const to = args.to as string | undefined;
      const repo = args.repo as string | undefined;
      const fuzzy = args.fuzzy === true;
      const direction = (args.direction as GraphDirection | undefined) ?? 'callees';
      const maxDepth = (args.maxDepth as number | undefined) ?? 4;

      const fromKeys = store.resolveNodes(from, repo, fuzzy).map((m) => m.key);
      if (fromKeys.length === 0) return text(`No entity found matching "${from}".${fuzzy ? '' : ' Try fuzzy:true.'}`);
      const getNeighbors = makeNeighborGetter(store, direction, edgeTypes(args));

      if (to) {
        const toKeys = new Set(store.resolveNodes(to, repo, fuzzy).map((m) => m.key));
        if (toKeys.size === 0) return text(`No entity found matching target "${to}".${fuzzy ? '' : ' Try fuzzy:true.'}`);
        const path = shortestPath(getNeighbors, fromKeys, toKeys, maxDepth);
        if (!path) return text(`No path from "${from}" to "${to}" within ${maxDepth} hops (direction: ${direction}).`);
        const labelOf = store.labelsOf(path);
        const arrow = direction === 'callers' ? ' ← ' : ' → ';
        const rendered = path.map((k) => labelOf.get(k) ?? k).join(arrow);
        return text(`# Path (${path.length - 1} hops)\n\n${rendered}\n\n${path.map((k) => `- \`${k}\``).join('\n')}`);
      }

      const nodes = reachable(getNeighbors, fromKeys, maxDepth);
      if (nodes.length === 0) return text(`No ${direction} reachable from "${from}" within ${maxDepth} hops.`);
      const labelOf = store.labelsOf(nodes.map((n) => n.key));
      const byDepth = new Map<number, string[]>();
      for (const { key, depth } of nodes) {
        if (!byDepth.has(depth)) byDepth.set(depth, []);
        byDepth.get(depth)!.push(`\`${labelOf.get(key) ?? key}\` (${key})`);
      }
      const sections = [...byDepth.entries()].sort((a, b) => a[0] - b[0])
        .map(([d, ks]) => `## Depth ${d}\n${ks.map((k) => `- ${k}`).join('\n')}`).join('\n\n');
      return text(`# Reachable from "${from}" (${direction}, ≤${maxDepth} hops)\n\n${nodes.length} nodes:\n\n${sections}`);
    }

    if (name === 'find_dead_code') {
      const repo = args.repo as string;
      const limit = (args.limit as number | undefined) ?? 50;
      const graph = await blobs.getJson<{ nodes?: any[]; links?: any[] }>(`${repo}/graph.json`);
      if (!graph) return toolError(`No graph found for repo "${repo}" — check the name with list_repos.`);
      const ENTITY_TYPES = new Set(['function', 'method', 'class', 'struct', 'enum', 'trait']);
      const inDegree = new Map<string, number>();
      for (const l of (graph.links ?? []) as any[]) {
        if (l.type === 'contains') continue;
        inDegree.set(l.target, (inDegree.get(l.target) ?? 0) + 1);
      }
      const candidates = ((graph.nodes ?? []) as any[])
        .filter((n) => ENTITY_TYPES.has(n.type) && (inDegree.get(n.id) ?? 0) === 0);
      // Same-file uses the graph has no edge for (a handler passed to app.get(…),
      // a callback): a name that occurs again in its file is not dead.
      const source = await indexedSources(ctx.projectName, repo, [...new Set(candidates.map((n) => n.file).filter(Boolean))] as string[]);
      const dead = candidates.filter((n) => {
        const src = source.get(n.file);
        return src === undefined || identifierCount(src, n.label ?? n.id) <= 1;
      });
      if (dead.length === 0) return text(`# Dead code in ${repo}\n\nNo zero-caller entities found.`);
      const rows = dead.slice(0, limit).map((n) =>
        `- \`${n.label ?? n.id}\` (${n.type})${n.file ? ` — ${n.file}` : ''}`).join('\n');
      return text(`# Dead code in ${repo} (heuristic)\n\n${dead.length} zero-caller entit${dead.length === 1 ? 'y' : 'ies'}:\n\n${rows}${dead.length > limit ? `\n\n... and ${dead.length - limit} more` : ''}\n\n_Note: exported APIs, reflection, and dynamic dispatch can cause false positives._`);
    }

    if (name === 'get_architecture') {
      const repo = args.repo as string | undefined;

      if (repo) {
        const profile = await loadProfile(ctx.projectName, repo, resolvedKnowledgeConfig());
        if (!profile) return text(missingProfileText(repo));
        const ep = (xs: any[]) => xs?.length ? xs.map((e) => `  - ${e.type}: ${e.identifier} — ${e.description}`).join('\n') : '  - (none)';
        const body = [
          `# ${profile.name} — ${profile.role} (${profile.domain})`,
          '', profile.description, '',
          `**Tech:** ${profile.technologies?.join(', ') || 'unknown'}`,
          `**Entry points:** ${profile.entryPoints?.join(', ') || 'unknown'}`,
          '', '## Exposes', ep(profile.exposes), '', '## Consumes', ep(profile.consumes),
        ].join('\n');
        return text(body);
      }

      const pg = await blobs.getJson<any>('PROJECT_GRAPH.json');
      if (pg) {
        const lines: string[] = ['# Project Architecture', '', pg.architectureSummary ?? ''];
        if (pg.repoRoles && Object.keys(pg.repoRoles).length) {
          lines.push('', '## Repo Roles');
          for (const [n, r] of Object.entries(pg.repoRoles)) {
            lines.push(`- **${n}** — ${(r as any).role} (${(r as any).criticality}): ${((r as any).responsibilities ?? []).join('; ')}`);
          }
        }
        if (pg.relationships?.length) {
          lines.push('', '## Relationships');
          for (const rel of pg.relationships) lines.push(`- ${rel.from} → ${rel.to} (${rel.type}): ${rel.description}`);
        }
        if (pg.keyFlows?.length) {
          lines.push('', '## Key Flows');
          for (const f of pg.keyFlows) {
            lines.push(`- **${f.name}** (trigger: ${f.trigger})`);
            for (const s of f.steps ?? []) lines.push(`  - ${s.repo}/${s.component}: ${s.action} [${s.protocol}]`);
          }
        }
        return text(lines.join('\n'));
      }

      const summaryText = await blobs.getText('PROJECT_SUMMARY.md');
      if (summaryText !== null) return text(summaryText);

      const profiles = await loadAllProfiles(ctx.projectName, resolvedKnowledgeConfig());
      if (profiles.length) {
        return text(`# Project Repos\n\n${profiles.map((p) => `- **${p.name}** — ${p.role} (${p.domain}): ${p.description}`).join('\n')}\n\n_A full architecture view needs the LLM project graph (\`anvil graph build\`)._`);
      }
      return text('No architecture data yet: it needs repo profiles (generated during indexing when an LLM is configured) or the LLM project graph (`anvil graph build`).');
    }

    if (name === 'search_graph') {
      const store = await getGraphStore(ctx.projectName, resolvedKnowledgeConfig());
      if (!store) return text(NO_GRAPH);
      const { rows, total } = store.searchNodes({
        name: args.name as string | undefined,
        type: args.type as string | undefined,
        file: args.file as string | undefined,
        repo: args.repo as string | undefined,
        minDegree: (args.minDegree as number | undefined) ?? 0,
      }, (args.limit as number | undefined) ?? 50);
      if (total === 0) return text('No entities match the given filters.');
      const body = rows.map((m) => `- \`${m.label}\` (${m.type}, ${m.file}) — degree ${m.degree}  \`${m.key}\``).join('\n');
      return text(`# search_graph — ${total} match${total === 1 ? '' : 'es'}\n\n${body}${total > rows.length ? `\n\n... and ${total - rows.length} more` : ''}`);
    }

    if (name === 'detect_changes') {
      const repo = args.repo as string;
      const limit = (args.limit as number | undefined) ?? 50;
      if (!ctx.directoryPath) {
        return toolError('detect_changes needs a local repo path — available in local/serve mode only (not remote-proxy mode).');
      }
      const candidate = join(ctx.directoryPath, repo);
      const repoPath = existsSync(join(candidate, '.git')) ? candidate : ctx.directoryPath;
      if (!existsSync(repoPath)) return toolError(`Repo path not found: ${repoPath}`);

      let baseSha = args.baseSha as string | undefined;
      if (!baseSha) {
        try {
          const meta = await blobs.getJson<{ lastIndexedSha?: string }>(`${repo}/index_meta.json`);
          baseSha = meta?.lastIndexedSha;
        } catch { /* ignore */ }
      }
      if (!baseSha) return toolError('No base commit available. Pass baseSha, or index the repo first so a last-indexed SHA exists.');

      const diff = getAllChanges(repoPath, baseSha);
      if (diff.fallbackToFull) return toolError(`git diff against ${baseSha.slice(0, 7)} failed or is too large to map incrementally. Check the base SHA.`);
      const changedFiles = getChangedFilesList(diff);
      if (changedFiles.length === 0 && diff.deleted.length === 0) return text(`No source changes since ${baseSha.slice(0, 7)}.`);

      const store = await getGraphStore(ctx.projectName, resolvedKnowledgeConfig());
      const changedKeys: string[] = [];
      const endpoints: string[] = [];
      const wholeFile: string[] = [];
      const unlocated = new Set<string>();
      let hops: Hop[] = [];
      let depRepos = new Set<string>();
      const fileLevel = new Set<string>();
      if (store) {
        // Added / deleted files: every node in them. Modified files: the
        // entities whose line range at the base overlaps a hunk.
        changedKeys.push(...store.nodesInFiles(repo, [...diff.added, ...diff.deleted]));
        const hunks = diffHunks(repoPath, baseSha, diff.modified);
        for (const file of diff.modified) {
          const fileKeys = store.nodesInFiles(repo, [file]);
          const types = store.nodeTypes(fileKeys);
          const modKey = `${repo}::${file}`;
          const entities = new Map(fileKeys
            .filter((k) => k.startsWith(`${modKey}::`) && !['module', 'external', 'package'].includes(types.get(k) ?? ''))
            .map((k) => [k.slice(modKey.length + 2), k]));
          endpoints.push(...fileKeys.filter((k) => types.get(k) === 'external'));
          let base: string;
          try { base = runGit(repoPath, ['show', `${baseSha}:${file}`]); } catch {
            wholeFile.push(file);
            changedKeys.push(...fileKeys.filter((k) => types.get(k) !== 'external'));
            continue;
          }
          const ranges = declarationRanges(base, [...entities.keys()]);
          const { names, fileLevel: touchesFile } = touchedEntities(ranges, hunks.get(file) ?? []);
          if (touchesFile && fileKeys.includes(modKey)) changedKeys.push(modKey);
          const located = new Set(ranges.map((r) => r.name));
          for (const [name, key] of entities) {
            if (names.has(name)) changedKeys.push(key);
            // A declaration the heuristic can't find can't be ruled out.
            else if (!located.has(name)) { changedKeys.push(key); unlocated.add(key); }
          }
        }
        for (const k of endpoints) fileLevel.add(k);
        ({ hops, repos: depRepos } = dependentHops(store, [...changedKeys, ...endpoints], 1, fileLevel));
      }
      const dependents = hops[0]?.edges ?? [];
      const depTotal = hops[0]?.total ?? 0;

      const lines = [
        `# Changes since ${baseSha.slice(0, 7)} — ${repo}`,
        '',
        `## Changed files: ${changedFiles.length} (+${diff.added.length} / ~${diff.modified.length})`,
        ...changedFiles.slice(0, 30).map((f) => `- ${f}${wholeFile.includes(f) ? ' (not readable at the base — every entity in the file)' : ''}`),
        '',
        `## Deleted files: ${diff.deleted.length}`,
        ...diff.deleted.slice(0, 30).map((f) => `- ${f}`),
        '',
        `## Affected entities: ${changedKeys.length}`,
        ...changedKeys.slice(0, 30).map((k) => `- \`${k}\`${unlocated.has(k) ? ' (declaration not found in the file — included to be safe)' : ''}`),
      ];
      if (endpoints.length) {
        lines.push('', `## File-level endpoints: ${endpoints.length} (cross-repo endpoints in modified files)`, ...endpoints.slice(0, 30).map((k) => `- \`${k}\``));
      }
      lines.push(
        '',
        `## Dependents: ${depTotal} edges from ${depRepos.size} repo(s)`,
        ...dependents.slice(0, limit).map((e) => edgeLine(e, fileLevel)),
        ...(depTotal > Math.min(dependents.length, limit) ? [`... and ${depTotal - Math.min(dependents.length, limit)} more`] : []),
        '',
        `## Affected repos: ${[...depRepos].join(', ') || 'none'}`,
      );
      return text(lines.join('\n'));
    }

    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return toolError(`Graph tool error: ${msg}`);
  }
}
