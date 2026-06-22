/**
 * Graph tools — AST graph queries, callers, dependencies, impact analysis,
 * call-path tracing, dead-code detection, and architecture overview.
 *
 * All tools read artifacts the indexer already writes:
 *   <KB>/system_graph_v2.json   — graphology export { nodes:[{key,attributes}],
 *                                  edges:[{source,target,attributes}] }
 *   <KB>/<repo>/graph.json       — per-repo GraphifyOutput { nodes:[{id,type,...}],
 *                                  links:[{source,target,type,confidence}] }
 * Node key convention: `repo::filePath::entity` (module nodes: `repo::filePath`).
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
} from '@esankhan3/anvil-knowledge-core';

// ---------------------------------------------------------------------------
// System-graph types + loaders (graphology export shape)
// ---------------------------------------------------------------------------

interface SysNode { key: string; attributes?: { label?: string; type?: string; repo?: string; file?: string } }
interface SysEdge { source: string; target: string; attributes?: { type?: string; relation?: string; confidence?: number } }
interface SysGraph { nodes: SysNode[]; edges: SysEdge[] }

const GRAPH_TOOL_NAMES = [
  'get_repo_graph', 'get_cross_repo_edges', 'find_callers', 'find_dependencies',
  'impact_analysis', 'trace_path', 'find_dead_code', 'get_architecture',
  'search_graph', 'detect_changes',
];

function loadSystemGraph(kbPath: string): SysGraph | null {
  const p = join(kbPath, 'system_graph_v2.json');
  if (!existsSync(p)) return null;
  try {
    const g = JSON.parse(readFileSync(p, 'utf-8'));
    return { nodes: g.nodes ?? [], edges: g.edges ?? [] };
  } catch {
    return null;
  }
}

/** Short, human-readable label for a node key. */
function nodeLabel(node: SysNode): string {
  return node.attributes?.label ?? node.key.split('::').slice(2).join('::') ?? node.key;
}

const edgeType = (e: SysEdge): string | undefined => e.attributes?.type ?? e.attributes?.relation;

/**
 * Resolve an entity name to system-graph node keys — PRECISE by default.
 * Default (exact): `attributes.label === name` OR key endsWith `::name`.
 * `fuzzy === true`: substring match on label or key (broader, noisier).
 */
function resolveEntityNodes(nodes: SysNode[], name: string, repo?: string, fuzzy = false): string[] {
  const inRepo = (key: string) => !repo || key.startsWith(repo + '::');
  if (fuzzy) {
    return nodes
      .filter((n) => inRepo(n.key) && ((n.attributes?.label ?? '').includes(name) || n.key.includes(name)))
      .map((n) => n.key);
  }
  return nodes
    .filter((n) => inRepo(n.key) && (n.attributes?.label === name || n.key.endsWith('::' + name)))
    .map((n) => n.key);
}

// ---------------------------------------------------------------------------
// Call-path traversal (confidence-weighted, skips structural `contains` edges)
// ---------------------------------------------------------------------------

type Direction = 'callees' | 'callers' | 'both';

function buildAdjacency(edges: SysEdge[], direction: Direction): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const add = (a: string, b: string) => {
    if (!adj.has(a)) adj.set(a, new Set());
    adj.get(a)!.add(b);
  };
  for (const e of edges) {
    if (!e.source || !e.target) continue;
    if (edgeType(e) === 'contains') continue;
    if ((e.attributes?.confidence ?? 0.8) < 0.7) continue;
    if (direction === 'callees' || direction === 'both') add(e.source, e.target);
    if (direction === 'callers' || direction === 'both') add(e.target, e.source);
  }
  return adj;
}

/** Shortest path from any `fromKeys` node to any `toKeys` node, ≤ maxDepth hops. */
function shortestPath(adj: Map<string, Set<string>>, fromKeys: string[], toKeys: Set<string>, maxDepth: number): string[] | null {
  const seed = fromKeys.find((k) => toKeys.has(k));
  if (seed) return [seed];
  const visited = new Set<string>(fromKeys);
  let frontier: string[][] = fromKeys.map((k) => [k]);
  for (let depth = 0; depth < maxDepth && frontier.length > 0; depth++) {
    const next: string[][] = [];
    for (const path of frontier) {
      for (const nb of adj.get(path[path.length - 1]) ?? []) {
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
function reachable(adj: Map<string, Set<string>>, fromKeys: string[], maxDepth: number, cap = 50): Array<{ key: string; depth: number }> {
  const visited = new Set<string>(fromKeys);
  const out: Array<{ key: string; depth: number }> = [];
  let frontier = [...fromKeys];
  for (let depth = 1; depth <= maxDepth && frontier.length > 0; depth++) {
    const next: string[] = [];
    for (const k of frontier) {
      for (const nb of adj.get(k) ?? []) {
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

  try {
    const kbPath = getKnowledgeBasePath(ctx.projectName);

    if (name === 'get_repo_graph') {
      const repo = args.repo as string;
      const graphPath = join(kbPath, repo, 'graph.json');
      if (!existsSync(graphPath)) {
        return { content: [{ type: 'text', text: `No graph found for repo "${repo}"` }] };
      }
      const graph = JSON.parse(readFileSync(graphPath, 'utf-8'));
      const summary = `# ${repo} AST Graph\n\n- **Nodes:** ${graph.nodes?.length ?? 0}\n- **Edges:** ${graph.links?.length ?? 0}\n\n## Entities\n${(graph.nodes ?? []).slice(0, 50).map((n: any) => `- \`${n.id}\` (${n.type})`).join('\n')}\n\n${graph.nodes?.length > 50 ? `... and ${graph.nodes.length - 50} more` : ''}`;
      return { content: [{ type: 'text', text: summary }] };
    }

    if (name === 'get_cross_repo_edges') {
      const sys = loadSystemGraph(kbPath);
      if (!sys) return { content: [{ type: 'text', text: 'No system graph found. Build KB first.' }] };
      const repo = args.repo as string | undefined;
      const relevant = repo
        ? sys.edges.filter((e) => e.source.startsWith(repo + '::') || e.target.startsWith(repo + '::'))
        : sys.edges;
      const crossRepo = relevant.filter((e) => {
        const src = e.source.split('::')[0];
        const tgt = e.target.split('::')[0];
        return src && tgt && src !== tgt;
      });
      if (crossRepo.length === 0) {
        return { content: [{ type: 'text', text: repo ? `No cross-repo edges found for "${repo}"` : 'No cross-repo edges found' }] };
      }
      const text = crossRepo.slice(0, 50).map((e) =>
        `- ${e.source.split('::')[0]} → ${e.target.split('::')[0]} (${edgeType(e) ?? 'edge'})`,
      ).join('\n');
      return { content: [{ type: 'text', text: `# Cross-Repo Edges${repo ? ` for ${repo}` : ''}\n\n${crossRepo.length} edges found:\n\n${text}${crossRepo.length > 50 ? `\n\n... and ${crossRepo.length - 50} more` : ''}` }] };
    }

    if (name === 'find_callers' || name === 'find_dependencies') {
      const funcName = args.function as string;
      const repoFilter = args.repo as string | undefined;
      const fuzzy = args.fuzzy === true;
      const sys = loadSystemGraph(kbPath);
      if (!sys) return { content: [{ type: 'text', text: 'No system graph found.' }] };

      const matchKeys = new Set(resolveEntityNodes(sys.nodes, funcName, repoFilter, fuzzy));
      if (matchKeys.size === 0) {
        return { content: [{ type: 'text', text: `No entity found matching "${funcName}"${repoFilter ? ` in ${repoFilter}` : ''}. Try fuzzy:true for substring matching.` }] };
      }

      const results = name === 'find_callers'
        ? sys.edges.filter((e) => matchKeys.has(e.target) && edgeType(e) !== 'contains').map((e) => e.source)
        : sys.edges.filter((e) => matchKeys.has(e.source) && edgeType(e) !== 'contains').map((e) => e.target);

      const unique = [...new Set(results)].slice(0, 30);
      const direction = name === 'find_callers' ? 'Callers of' : 'Dependencies of';
      if (unique.length === 0) {
        return { content: [{ type: 'text', text: `# ${direction} "${funcName}"\n\nMatched ${matchKeys.size} entit${matchKeys.size === 1 ? 'y' : 'ies'}, but no ${name === 'find_callers' ? 'callers' : 'dependencies'} found.` }] };
      }
      return { content: [{ type: 'text', text: `# ${direction} "${funcName}"\n\n${unique.length} found:\n${unique.map((r) => `- \`${r}\``).join('\n')}` }] };
    }

    if (name === 'impact_analysis') {
      const file = args.file as string;
      const repo = args.repo as string;
      const entity = args.entity as string | undefined;
      const sys = loadSystemGraph(kbPath);
      if (!sys) return { content: [{ type: 'text', text: 'No system graph found.' }] };

      // File-scoped node match; precise entity match (endsWith `::entity`).
      const fileNodes = sys.nodes.filter((n) => {
        const matchesFile = n.key.includes(`${repo}::${file}::`);
        const matchesEntity = !entity || n.key.endsWith(`::${entity}`);
        return matchesFile && matchesEntity;
      });
      const nodeKeys = new Set(fileNodes.map((n) => n.key));
      const dependents = sys.edges.filter((e) => nodeKeys.has(e.target) && !nodeKeys.has(e.source) && edgeType(e) !== 'contains');
      const dependentRepos = new Set(dependents.map((e) => e.source.split('::')[0]));

      const text = [
        `# Impact Analysis: ${repo}/${file}${entity ? `::${entity}` : ''}`,
        '',
        `## Entities in scope: ${fileNodes.length}`,
        ...fileNodes.slice(0, 20).map((n) => `- \`${n.key}\``),
        '',
        `## Dependents: ${dependents.length} edges from ${dependentRepos.size} repos`,
        ...dependents.slice(0, 30).map((e) => `- \`${e.source}\` → \`${e.target}\` (${edgeType(e) ?? 'edge'})`),
        dependents.length > 30 ? `\n... and ${dependents.length - 30} more` : '',
        '',
        `## Affected repos: ${[...dependentRepos].join(', ') || 'none'}`,
      ].join('\n');
      return { content: [{ type: 'text', text }] };
    }

    if (name === 'trace_path') {
      const sys = loadSystemGraph(kbPath);
      if (!sys) return { content: [{ type: 'text', text: 'No system graph found.' }] };
      const from = args.from as string;
      const to = args.to as string | undefined;
      const repo = args.repo as string | undefined;
      const fuzzy = args.fuzzy === true;
      const direction = ((args.direction as Direction) ?? 'callees');
      const maxDepth = Math.max(1, Math.min(10, (args.maxDepth as number) || 4));

      const fromKeys = resolveEntityNodes(sys.nodes, from, repo, fuzzy);
      if (fromKeys.length === 0) {
        return { content: [{ type: 'text', text: `No entity found matching "${from}". Try fuzzy:true.` }] };
      }
      const labelOf = new Map(sys.nodes.map((n) => [n.key, nodeLabel(n)]));
      const adj = buildAdjacency(sys.edges, direction);

      if (to) {
        const toKeys = new Set(resolveEntityNodes(sys.nodes, to, repo, fuzzy));
        if (toKeys.size === 0) {
          return { content: [{ type: 'text', text: `No entity found matching target "${to}". Try fuzzy:true.` }] };
        }
        const path = shortestPath(adj, fromKeys, toKeys, maxDepth);
        if (!path) {
          return { content: [{ type: 'text', text: `No path from "${from}" to "${to}" within ${maxDepth} hops (direction: ${direction}).` }] };
        }
        const arrow = direction === 'callers' ? ' ← ' : ' → ';
        const rendered = path.map((k) => labelOf.get(k) ?? k).join(arrow);
        return { content: [{ type: 'text', text: `# Path (${path.length - 1} hops)\n\n${rendered}\n\n${path.map((k) => `- \`${k}\``).join('\n')}` }] };
      }

      const nodes = reachable(adj, fromKeys, maxDepth);
      if (nodes.length === 0) {
        return { content: [{ type: 'text', text: `No ${direction} reachable from "${from}" within ${maxDepth} hops.` }] };
      }
      const byDepth = new Map<number, string[]>();
      for (const { key, depth } of nodes) {
        if (!byDepth.has(depth)) byDepth.set(depth, []);
        byDepth.get(depth)!.push(`\`${labelOf.get(key) ?? key}\` (${key})`);
      }
      const sections = [...byDepth.entries()].sort((a, b) => a[0] - b[0])
        .map(([d, ks]) => `## Depth ${d}\n${ks.map((k) => `- ${k}`).join('\n')}`).join('\n\n');
      return { content: [{ type: 'text', text: `# Reachable from "${from}" (${direction}, ≤${maxDepth} hops)\n\n${nodes.length} nodes:\n\n${sections}` }] };
    }

    if (name === 'find_dead_code') {
      const repo = args.repo as string;
      const limit = (args.limit as number) || 50;
      const graphPath = join(kbPath, repo, 'graph.json');
      if (!existsSync(graphPath)) {
        return { content: [{ type: 'text', text: `No graph found for repo "${repo}"` }] };
      }
      const graph = JSON.parse(readFileSync(graphPath, 'utf-8'));
      const ENTITY_TYPES = new Set(['function', 'method', 'class', 'struct', 'enum', 'trait']);
      const inDegree = new Map<string, number>();
      for (const l of (graph.links ?? []) as any[]) {
        if (l.type === 'contains') continue;
        inDegree.set(l.target, (inDegree.get(l.target) ?? 0) + 1);
      }
      const dead = ((graph.nodes ?? []) as any[])
        .filter((n) => ENTITY_TYPES.has(n.type) && (inDegree.get(n.id) ?? 0) === 0);
      if (dead.length === 0) {
        return { content: [{ type: 'text', text: `# Dead code in ${repo}\n\nNo zero-caller entities found.` }] };
      }
      const rows = dead.slice(0, limit).map((n) =>
        `- \`${n.label ?? n.id}\` (${n.type})${n.file ? ` — ${n.file}` : ''}`).join('\n');
      return { content: [{ type: 'text', text: `# Dead code in ${repo} (heuristic)\n\n${dead.length} zero-caller entit${dead.length === 1 ? 'y' : 'ies'}:\n\n${rows}${dead.length > limit ? `\n\n... and ${dead.length - limit} more` : ''}\n\n_Note: exported APIs, reflection, and dynamic dispatch can cause false positives._` }] };
    }

    if (name === 'get_architecture') {
      const repo = args.repo as string | undefined;

      if (repo) {
        const profile = loadProfile(ctx.projectName, repo);
        if (!profile) {
          return { content: [{ type: 'text', text: `No profile for "${repo}". Run profiling (requires LLM) to generate one.` }] };
        }
        const ep = (xs: any[]) => xs?.length ? xs.map((e) => `  - ${e.type}: ${e.identifier} — ${e.description}`).join('\n') : '  - (none)';
        const text = [
          `# ${profile.name} — ${profile.role} (${profile.domain})`,
          '', profile.description, '',
          `**Tech:** ${profile.technologies?.join(', ') || 'unknown'}`,
          `**Entry points:** ${profile.entryPoints?.join(', ') || 'unknown'}`,
          '', '## Exposes', ep(profile.exposes), '', '## Consumes', ep(profile.consumes),
        ].join('\n');
        return { content: [{ type: 'text', text }] };
      }

      // Read PROJECT_GRAPH.json / PROJECT_SUMMARY.md from the SAME per-project
      // dir as every other artifact (getKnowledgeBasePath honors
      // CODE_SEARCH_DATA_DIR; the knowledge-core loaders use a separate
      // ANVIL_HOME constant that can diverge).
      const pgPath = join(kbPath, 'PROJECT_GRAPH.json');
      const pg = existsSync(pgPath) ? JSON.parse(readFileSync(pgPath, 'utf-8')) : null;
      if (pg) {
        const lines: string[] = ['# Project Architecture', '', pg.architectureSummary ?? ''];
        if (pg.repoRoles && Object.keys(pg.repoRoles).length) {
          lines.push('', '## Repo Roles');
          for (const [name, r] of Object.entries(pg.repoRoles)) {
            lines.push(`- **${name}** — ${(r as any).role} (${(r as any).criticality}): ${((r as any).responsibilities ?? []).join('; ')}`);
          }
        }
        if (pg.relationships?.length) {
          lines.push('', '## Relationships');
          for (const rel of pg.relationships) {
            lines.push(`- ${rel.from} → ${rel.to} (${rel.type}): ${rel.description}`);
          }
        }
        if (pg.keyFlows?.length) {
          lines.push('', '## Key Flows');
          for (const f of pg.keyFlows) {
            lines.push(`- **${f.name}** (trigger: ${f.trigger})`);
            for (const s of f.steps ?? []) lines.push(`  - ${s.repo}/${s.component}: ${s.action} [${s.protocol}]`);
          }
        }
        return { content: [{ type: 'text', text: lines.join('\n') }] };
      }

      const summaryPath = join(kbPath, 'PROJECT_SUMMARY.md');
      if (existsSync(summaryPath)) {
        return { content: [{ type: 'text', text: readFileSync(summaryPath, 'utf-8') }] };
      }

      const profiles = loadAllProfiles(ctx.projectName);
      if (profiles.length) {
        const text = `# Project Repos\n\n${profiles.map((p) => `- **${p.name}** — ${p.role} (${p.domain}): ${p.description}`).join('\n')}\n\n_Run project-graph generation (requires LLM) for a full architecture view._`;
        return { content: [{ type: 'text', text }] };
      }
      return { content: [{ type: 'text', text: 'No architecture data yet. Index the project, then run profiling / project-graph generation (requires an LLM) for an architecture overview.' }] };
    }

    if (name === 'search_graph') {
      const sys = loadSystemGraph(kbPath);
      if (!sys) return { content: [{ type: 'text', text: 'No system graph found. Build KB first.' }] };
      const repo = args.repo as string | undefined;
      const type = args.type as string | undefined;
      const file = args.file as string | undefined;
      const minDegree = (args.minDegree as number) ?? 0;
      const limit = (args.limit as number) || 50;
      const nameArg = args.name as string | undefined;

      let nameTest: (s: string) => boolean = () => true;
      if (nameArg) {
        try {
          const re = new RegExp(nameArg, 'i');
          nameTest = (s) => re.test(s);
        } catch {
          const lc = nameArg.toLowerCase();
          nameTest = (s) => s.toLowerCase().includes(lc);
        }
      }

      // Degree = non-`contains` edges touching the node.
      const degree = new Map<string, number>();
      for (const e of sys.edges) {
        if (edgeType(e) === 'contains') continue;
        degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
        degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
      }

      const matches = sys.nodes
        .filter((n) => {
          if (repo && !n.key.startsWith(repo + '::')) return false;
          if (type && n.attributes?.type !== type) return false;
          const f = n.attributes?.file ?? n.key.split('::')[1] ?? '';
          if (file && !f.includes(file)) return false;
          if (nameArg && !(nameTest(n.attributes?.label ?? '') || nameTest(n.key))) return false;
          return (degree.get(n.key) ?? 0) >= minDegree;
        })
        .map((n) => ({ key: n.key, label: nodeLabel(n), type: n.attributes?.type ?? '?', file: n.attributes?.file ?? n.key.split('::')[1] ?? '', deg: degree.get(n.key) ?? 0 }))
        .sort((a, b) => b.deg - a.deg);

      if (matches.length === 0) {
        return { content: [{ type: 'text', text: 'No entities match the given filters.' }] };
      }
      const rows = matches.slice(0, limit).map((m) =>
        `- \`${m.label}\` (${m.type}, ${m.file}) — degree ${m.deg}  \`${m.key}\``).join('\n');
      return { content: [{ type: 'text', text: `# search_graph — ${matches.length} match${matches.length === 1 ? '' : 'es'}\n\n${rows}${matches.length > limit ? `\n\n... and ${matches.length - limit} more` : ''}` }] };
    }

    if (name === 'detect_changes') {
      const repo = args.repo as string;
      const limit = (args.limit as number) || 50;
      if (!ctx.directoryPath) {
        return { content: [{ type: 'text', text: 'detect_changes needs a local repo path — available in local/serve mode only (not remote-proxy mode).' }] };
      }
      const candidate = join(ctx.directoryPath, repo);
      const repoPath = existsSync(join(candidate, '.git')) ? candidate : ctx.directoryPath;
      if (!existsSync(repoPath)) {
        return { content: [{ type: 'text', text: `Repo path not found: ${repoPath}` }] };
      }

      let baseSha = args.baseSha as string | undefined;
      if (!baseSha) {
        const metaPath = join(kbPath, repo, 'index_meta.json');
        if (existsSync(metaPath)) {
          try { baseSha = JSON.parse(readFileSync(metaPath, 'utf-8')).lastIndexedSha; } catch { /* ignore */ }
        }
      }
      if (!baseSha) {
        return { content: [{ type: 'text', text: 'No base commit available. Pass baseSha, or index the repo first so a last-indexed SHA exists.' }] };
      }

      const diff = getAllChanges(repoPath, baseSha);
      if (diff.fallbackToFull) {
        return { content: [{ type: 'text', text: `git diff against ${baseSha.slice(0, 7)} failed or is too large to map incrementally. Check the base SHA.` }] };
      }
      const changedFiles = getChangedFilesList(diff);
      if (changedFiles.length === 0 && diff.deleted.length === 0) {
        return { content: [{ type: 'text', text: `No source changes since ${baseSha.slice(0, 7)}.` }] };
      }

      const sys = loadSystemGraph(kbPath);
      const changedKeys = new Set<string>();
      if (sys) {
        for (const f of changedFiles) {
          for (const n of sys.nodes) {
            if (n.key.startsWith(`${repo}::${f}::`) || n.key === `${repo}::${f}`) changedKeys.add(n.key);
          }
        }
      }
      const dependents = sys
        ? sys.edges.filter((e) => changedKeys.has(e.target) && !changedKeys.has(e.source) && edgeType(e) !== 'contains')
        : [];
      const dependentRepos = new Set(dependents.map((e) => e.source.split('::')[0]));

      const lines = [
        `# Changes since ${baseSha.slice(0, 7)} — ${repo}`,
        '',
        `## Changed files: ${changedFiles.length} (+${diff.added.length} / ~${diff.modified.length}), deleted ${diff.deleted.length}`,
        ...changedFiles.slice(0, 30).map((f) => `- ${f}`),
        '',
        `## Affected entities: ${changedKeys.size}`,
        ...[...changedKeys].slice(0, 30).map((k) => `- \`${k}\``),
        '',
        `## Dependents: ${dependents.length} edges from ${dependentRepos.size} repo(s)`,
        ...dependents.slice(0, limit).map((e) => `- \`${e.source}\` → \`${e.target}\` (${edgeType(e) ?? 'edge'})`),
        '',
        `## Affected repos: ${[...dependentRepos].join(', ') || 'none'}`,
      ];
      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Graph tool error: ${msg}` }] };
  }
}
