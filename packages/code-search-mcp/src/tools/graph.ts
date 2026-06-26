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

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerContext } from '../server.js';
import {
  getKnowledgeBasePath,
  loadAllProfiles,
  loadProfile,
  getAllChanges,
  getChangedFilesList,
  openSystemGraphStore,
} from '@esankhan3/anvil-knowledge-core';
import type { GraphStore, GraphDirection } from '@esankhan3/anvil-knowledge-core';

const GRAPH_TOOL_NAMES = [
  'get_repo_graph', 'get_cross_repo_edges', 'find_callers', 'find_dependencies',
  'impact_analysis', 'trace_path', 'find_dead_code', 'get_architecture',
  'search_graph', 'detect_changes',
];

const repoOf = (key: string): string => key.split('::')[0] ?? '';

// ---------------------------------------------------------------------------
// Call-path traversal — BFS over neighbors fetched lazily from the store
// (cached per traversal), so only touched nodes are read, never the whole graph.
// ---------------------------------------------------------------------------

function makeNeighborGetter(store: GraphStore, direction: GraphDirection): (key: string) => string[] {
  const cache = new Map<string, string[]>();
  return (key) => {
    let v = cache.get(key);
    if (v === undefined) { v = store.neighborsOf(key, direction); cache.set(key, v); }
    return v;
  };
}

/** Shortest path from any `fromKeys` node to any `toKeys` node, ≤ maxDepth hops. */
function shortestPath(getNeighbors: (k: string) => string[], fromKeys: string[], toKeys: Set<string>, maxDepth: number): string[] | null {
  const seed = fromKeys.find((k) => toKeys.has(k));
  if (seed) return [seed];
  const visited = new Set<string>(fromKeys);
  let frontier: string[][] = fromKeys.map((k) => [k]);
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[][] = [];
    for (const path of frontier) {
      for (const nb of getNeighbors(path[path.length - 1])) {
        if (visited.has(nb)) continue;
        if (toKeys.has(nb)) return [...path, nb];
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
// Tool descriptors
// ---------------------------------------------------------------------------

export function registerGraphTools() {
  return [
    {
      name: 'get_repo_graph',
      description: 'Get the AST knowledge graph for a repo — entities (functions, classes, types) and their relationships (calls, imports, inheritance).',
      inputSchema: {
        type: 'object' as const,
        properties: { repo: { type: 'string', description: 'Repository name' } },
        required: ['repo'],
      },
    },
    {
      name: 'get_cross_repo_edges',
      description: 'Get connections between repos — shared deps, Kafka topics, HTTP routes, database tables, gRPC services, etc.',
      inputSchema: {
        type: 'object' as const,
        properties: { repo: { type: 'string', description: 'Filter to edges involving this repo (optional)' } },
      },
    },
    {
      name: 'find_callers',
      description: 'Find all functions/methods that call a given function (exact name match by default). Uses the AST graph.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          function: { type: 'string', description: 'Function name to find callers of' },
          repo: { type: 'string', description: 'Limit search to this repo (optional)' },
          fuzzy: { type: 'boolean', description: 'Substring-match the name instead of exact (default false)' },
        },
        required: ['function'],
      },
    },
    {
      name: 'find_dependencies',
      description: 'Find what a function depends on — calls, imports, type references (exact name match by default).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          function: { type: 'string', description: 'Function name' },
          repo: { type: 'string', description: 'Limit to this repo (optional)' },
          fuzzy: { type: 'boolean', description: 'Substring-match the name instead of exact (default false)' },
        },
        required: ['function'],
      },
    },
    {
      name: 'impact_analysis',
      description: 'Analyze what would be affected if a file or entity is changed. Traces callers, dependents, and cross-repo connections.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          file: { type: 'string', description: 'File path (relative to repo root)' },
          entity: { type: 'string', description: 'Specific entity name (optional — if omitted, analyzes all entities in the file)' },
          repo: { type: 'string', description: 'Repository name' },
        },
        required: ['file', 'repo'],
      },
    },
    {
      name: 'trace_path',
      description: 'Trace the call chain from a function across multiple hops. With "to", returns the shortest path between two functions; otherwise returns the reachable call tree. Follows confidence-weighted call/import/use edges.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          from: { type: 'string', description: 'Starting function name or qualified id (repo::file::entity)' },
          to: { type: 'string', description: 'Target function name or qualified id (optional — shortest path)' },
          repo: { type: 'string', description: 'Limit resolution to this repo (optional)' },
          direction: { type: 'string', enum: ['callees', 'callers', 'both'], description: 'Traverse callees (what it calls), callers (who calls it), or both. Default callees.' },
          maxDepth: { type: 'number', description: 'Max hops to traverse (default 4)' },
          fuzzy: { type: 'boolean', description: 'Substring-match names instead of exact (default false)' },
        },
        required: ['from'],
      },
    },
    {
      name: 'find_dead_code',
      description: 'List entities (functions, methods, classes) with no callers/importers in a repo — likely dead code. Heuristic: exported APIs, reflection, and dynamic dispatch produce false positives.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          repo: { type: 'string', description: 'Repository name' },
          limit: { type: 'number', description: 'Max results (default 50)' },
        },
        required: ['repo'],
      },
    },
    {
      name: 'get_architecture',
      description: 'High-level architecture overview of the project — repo roles, key flows, and how services connect. Built from the LLM-generated project graph and repo profiles.',
      inputSchema: {
        type: 'object' as const,
        properties: { repo: { type: 'string', description: 'Drill into one repo profile (optional)' } },
      },
    },
    {
      name: 'search_graph',
      description: 'Structural search over the knowledge graph: filter entities by name (regex/substring), type, file, and repo; rank by connectivity (degree). Answers "which functions matter most in this module" — a structural question search/grep can\'t.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Name regex or substring to match (optional)' },
          type: { type: 'string', description: 'Entity type filter: function | class | interface | method | type | … (optional)' },
          file: { type: 'string', description: 'File-path substring filter (optional)' },
          repo: { type: 'string', description: 'Limit to this repo (optional)' },
          minDegree: { type: 'number', description: 'Only entities with at least this many connections (default 0)' },
          limit: { type: 'number', description: 'Max results (default 50)' },
        },
      },
    },
    {
      name: 'detect_changes',
      description: 'Map a git diff to affected symbols and their dependents. Compares the working tree against a base commit (or the last-indexed SHA) and reports which entities changed and what depends on them — a blast-radius / code-review tool. Requires a local repo (local/serve mode).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          repo: { type: 'string', description: 'Repository name' },
          baseSha: { type: 'string', description: 'Git base commit to diff against (default: last-indexed SHA)' },
          limit: { type: 'number', description: 'Max dependent edges to list (default 50)' },
        },
        required: ['repo'],
      },
    },
  ];
}

// ---------------------------------------------------------------------------
// Tool dispatch
// ---------------------------------------------------------------------------

export async function handleGraphTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ServerContext,
): Promise<{ content: Array<{ type: string; text: string }> } | null> {
  if (!GRAPH_TOOL_NAMES.includes(name)) return null;
  const text = (t: string) => ({ content: [{ type: 'text', text: t }] });
  const NO_GRAPH = 'No system graph found. Build KB first.';

  try {
    const kbPath = getKnowledgeBasePath(ctx.projectName);

    if (name === 'get_repo_graph') {
      const repo = args.repo as string;
      const graphPath = join(kbPath, repo, 'graph.json');
      if (!existsSync(graphPath)) return text(`No graph found for repo "${repo}"`);
      const graph = JSON.parse(readFileSync(graphPath, 'utf-8'));
      const summary = `# ${repo} AST Graph\n\n- **Nodes:** ${graph.nodes?.length ?? 0}\n- **Edges:** ${graph.links?.length ?? 0}\n\n## Entities\n${(graph.nodes ?? []).slice(0, 50).map((n: any) => `- \`${n.id}\` (${n.type})`).join('\n')}\n\n${graph.nodes?.length > 50 ? `... and ${graph.nodes.length - 50} more` : ''}`;
      return text(summary);
    }

    if (name === 'get_cross_repo_edges') {
      const store = await openSystemGraphStore(kbPath);
      if (!store) return text(NO_GRAPH);
      try {
        const repo = args.repo as string | undefined;
        const { edges, total } = store.crossRepoEdges(repo, 50);
        if (total === 0) return text(repo ? `No cross-repo edges found for "${repo}"` : 'No cross-repo edges found');
        const body = edges.map((e) => `- ${repoOf(e.source)} → ${repoOf(e.target)} (${e.type ?? 'edge'})`).join('\n');
        return text(`# Cross-Repo Edges${repo ? ` for ${repo}` : ''}\n\n${total} edges found:\n\n${body}${total > edges.length ? `\n\n... and ${total - edges.length} more` : ''}`);
      } finally { store.close(); }
    }

    if (name === 'find_callers' || name === 'find_dependencies') {
      const store = await openSystemGraphStore(kbPath);
      if (!store) return text('No system graph found.');
      try {
        const funcName = args.function as string;
        const repoFilter = args.repo as string | undefined;
        const fuzzy = args.fuzzy === true;
        const matched = store.resolveNodes(funcName, repoFilter, fuzzy);
        if (matched.length === 0) {
          return text(`No entity found matching "${funcName}"${repoFilter ? ` in ${repoFilter}` : ''}. Try fuzzy:true for substring matching.`);
        }
        const keys = matched.map((m) => m.key);
        const unique = name === 'find_callers' ? store.callers(keys, 30) : store.dependencies(keys, 30);
        const direction = name === 'find_callers' ? 'Callers of' : 'Dependencies of';
        if (unique.length === 0) {
          return text(`# ${direction} "${funcName}"\n\nMatched ${matched.length} entit${matched.length === 1 ? 'y' : 'ies'}, but no ${name === 'find_callers' ? 'callers' : 'dependencies'} found.`);
        }
        return text(`# ${direction} "${funcName}"\n\n${unique.length} found:\n${unique.map((r) => `- \`${r}\``).join('\n')}`);
      } finally { store.close(); }
    }

    if (name === 'impact_analysis') {
      const store = await openSystemGraphStore(kbPath);
      if (!store) return text('No system graph found.');
      try {
        const file = args.file as string;
        const repo = args.repo as string;
        const entity = args.entity as string | undefined;
        const fileKeys = store.nodesInFiles(repo, [file], entity);
        const { edges: dependents, total, repos } = store.dependents(fileKeys, 30);
        const body = [
          `# Impact Analysis: ${repo}/${file}${entity ? `::${entity}` : ''}`,
          '',
          `## Entities in scope: ${fileKeys.length}`,
          ...fileKeys.slice(0, 20).map((k) => `- \`${k}\``),
          '',
          `## Dependents: ${total} edges from ${repos.length} repos`,
          ...dependents.map((e) => `- \`${e.source}\` → \`${e.target}\` (${e.type ?? 'edge'})`),
          total > dependents.length ? `\n... and ${total - dependents.length} more` : '',
          '',
          `## Affected repos: ${repos.join(', ') || 'none'}`,
        ].join('\n');
        return text(body);
      } finally { store.close(); }
    }

    if (name === 'trace_path') {
      const store = await openSystemGraphStore(kbPath);
      if (!store) return text('No system graph found.');
      try {
        const from = args.from as string;
        const to = args.to as string | undefined;
        const repo = args.repo as string | undefined;
        const fuzzy = args.fuzzy === true;
        const direction = ((args.direction as GraphDirection) ?? 'callees');
        const maxDepth = Math.max(1, Math.min(10, (args.maxDepth as number) || 4));

        const fromKeys = store.resolveNodes(from, repo, fuzzy).map((m) => m.key);
        if (fromKeys.length === 0) return text(`No entity found matching "${from}". Try fuzzy:true.`);
        const getNeighbors = makeNeighborGetter(store, direction);

        if (to) {
          const toKeys = new Set(store.resolveNodes(to, repo, fuzzy).map((m) => m.key));
          if (toKeys.size === 0) return text(`No entity found matching target "${to}". Try fuzzy:true.`);
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
      } finally { store.close(); }
    }

    if (name === 'find_dead_code') {
      const repo = args.repo as string;
      const limit = (args.limit as number) || 50;
      const graphPath = join(kbPath, repo, 'graph.json');
      if (!existsSync(graphPath)) return text(`No graph found for repo "${repo}"`);
      const graph = JSON.parse(readFileSync(graphPath, 'utf-8'));
      const ENTITY_TYPES = new Set(['function', 'method', 'class', 'struct', 'enum', 'trait']);
      const inDegree = new Map<string, number>();
      for (const l of (graph.links ?? []) as any[]) {
        if (l.type === 'contains') continue;
        inDegree.set(l.target, (inDegree.get(l.target) ?? 0) + 1);
      }
      const dead = ((graph.nodes ?? []) as any[])
        .filter((n) => ENTITY_TYPES.has(n.type) && (inDegree.get(n.id) ?? 0) === 0);
      if (dead.length === 0) return text(`# Dead code in ${repo}\n\nNo zero-caller entities found.`);
      const rows = dead.slice(0, limit).map((n) =>
        `- \`${n.label ?? n.id}\` (${n.type})${n.file ? ` — ${n.file}` : ''}`).join('\n');
      return text(`# Dead code in ${repo} (heuristic)\n\n${dead.length} zero-caller entit${dead.length === 1 ? 'y' : 'ies'}:\n\n${rows}${dead.length > limit ? `\n\n... and ${dead.length - limit} more` : ''}\n\n_Note: exported APIs, reflection, and dynamic dispatch can cause false positives._`);
    }

    if (name === 'get_architecture') {
      const repo = args.repo as string | undefined;

      if (repo) {
        const profile = loadProfile(ctx.projectName, repo);
        if (!profile) return text(`No profile for "${repo}". Run profiling (requires LLM) to generate one.`);
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

      const pgPath = join(kbPath, 'PROJECT_GRAPH.json');
      const pg = existsSync(pgPath) ? JSON.parse(readFileSync(pgPath, 'utf-8')) : null;
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

      const summaryPath = join(kbPath, 'PROJECT_SUMMARY.md');
      if (existsSync(summaryPath)) return text(readFileSync(summaryPath, 'utf-8'));

      const profiles = loadAllProfiles(ctx.projectName);
      if (profiles.length) {
        return text(`# Project Repos\n\n${profiles.map((p) => `- **${p.name}** — ${p.role} (${p.domain}): ${p.description}`).join('\n')}\n\n_Run project-graph generation (requires LLM) for a full architecture view._`);
      }
      return text('No architecture data yet. Index the project, then run profiling / project-graph generation (requires an LLM) for an architecture overview.');
    }

    if (name === 'search_graph') {
      const store = await openSystemGraphStore(kbPath);
      if (!store) return text(NO_GRAPH);
      try {
        const { rows, total } = store.searchNodes({
          name: args.name as string | undefined,
          type: args.type as string | undefined,
          file: args.file as string | undefined,
          repo: args.repo as string | undefined,
          minDegree: (args.minDegree as number) ?? 0,
        }, (args.limit as number) || 50);
        if (total === 0) return text('No entities match the given filters.');
        const body = rows.map((m) => `- \`${m.label}\` (${m.type}, ${m.file}) — degree ${m.degree}  \`${m.key}\``).join('\n');
        return text(`# search_graph — ${total} match${total === 1 ? '' : 'es'}\n\n${body}${total > rows.length ? `\n\n... and ${total - rows.length} more` : ''}`);
      } finally { store.close(); }
    }

    if (name === 'detect_changes') {
      const repo = args.repo as string;
      const limit = (args.limit as number) || 50;
      if (!ctx.directoryPath) {
        return text('detect_changes needs a local repo path — available in local/serve mode only (not remote-proxy mode).');
      }
      const candidate = join(ctx.directoryPath, repo);
      const repoPath = existsSync(join(candidate, '.git')) ? candidate : ctx.directoryPath;
      if (!existsSync(repoPath)) return text(`Repo path not found: ${repoPath}`);

      let baseSha = args.baseSha as string | undefined;
      if (!baseSha) {
        const metaPath = join(kbPath, repo, 'index_meta.json');
        if (existsSync(metaPath)) {
          try { baseSha = JSON.parse(readFileSync(metaPath, 'utf-8')).lastIndexedSha; } catch { /* ignore */ }
        }
      }
      if (!baseSha) return text('No base commit available. Pass baseSha, or index the repo first so a last-indexed SHA exists.');

      const diff = getAllChanges(repoPath, baseSha);
      if (diff.fallbackToFull) return text(`git diff against ${baseSha.slice(0, 7)} failed or is too large to map incrementally. Check the base SHA.`);
      const changedFiles = getChangedFilesList(diff);
      if (changedFiles.length === 0 && diff.deleted.length === 0) return text(`No source changes since ${baseSha.slice(0, 7)}.`);

      const store = await openSystemGraphStore(kbPath);
      let changedKeys: string[] = [];
      let dependents: Array<{ source: string; target: string; type?: string }> = [];
      let depTotal = 0;
      let depRepos: string[] = [];
      if (store) {
        try {
          changedKeys = store.nodesInFiles(repo, changedFiles);
          const d = store.dependents(changedKeys, limit);
          dependents = d.edges; depTotal = d.total; depRepos = d.repos;
        } finally { store.close(); }
      }

      const lines = [
        `# Changes since ${baseSha.slice(0, 7)} — ${repo}`,
        '',
        `## Changed files: ${changedFiles.length} (+${diff.added.length} / ~${diff.modified.length}), deleted ${diff.deleted.length}`,
        ...changedFiles.slice(0, 30).map((f) => `- ${f}`),
        '',
        `## Affected entities: ${changedKeys.length}`,
        ...changedKeys.slice(0, 30).map((k) => `- \`${k}\``),
        '',
        `## Dependents: ${depTotal} edges from ${depRepos.length} repo(s)`,
        ...dependents.map((e) => `- \`${e.source}\` → \`${e.target}\` (${e.type ?? 'edge'})`),
        '',
        `## Affected repos: ${depRepos.join(', ') || 'none'}`,
      ];
      return text(lines.join('\n'));
    }

    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Graph tool error: ${msg}` }] };
  }
}
