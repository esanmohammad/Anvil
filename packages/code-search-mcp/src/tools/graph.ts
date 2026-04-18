/**
 * Graph tools — AST graph queries, callers, dependencies, impact analysis.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerContext } from '../server.js';
import { getKnowledgeBasePath } from '../core/config.js';

export function registerGraphTools() {
  return [
    {
      name: 'get_repo_graph',
      description: 'Get the AST knowledge graph for a repo — entities (functions, classes, types) and their relationships (calls, imports, inheritance).',
      inputSchema: {
        type: 'object' as const,
        properties: {
          repo: { type: 'string', description: 'Repository name' },
        },
        required: ['repo'],
      },
    },
    {
      name: 'get_cross_repo_edges',
      description: 'Get connections between repos — shared deps, Kafka topics, HTTP routes, database tables, gRPC services, etc.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          repo: { type: 'string', description: 'Filter to edges involving this repo (optional)' },
        },
      },
    },
    {
      name: 'find_callers',
      description: 'Find all functions/methods that call a given function. Uses the AST graph.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          function: { type: 'string', description: 'Function name to find callers of' },
          repo: { type: 'string', description: 'Limit search to this repo (optional)' },
        },
        required: ['function'],
      },
    },
    {
      name: 'find_dependencies',
      description: 'Find what a function depends on — calls, imports, type references.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          function: { type: 'string', description: 'Function name' },
          repo: { type: 'string', description: 'Limit to this repo (optional)' },
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
  ];
}

export async function handleGraphTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ServerContext,
): Promise<{ content: Array<{ type: string; text: string }> } | null> {
  if (!['get_repo_graph', 'get_cross_repo_edges', 'find_callers', 'find_dependencies', 'impact_analysis'].includes(name)) return null;

  try {
    // getKnowledgeBasePath imported at top
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
      const sysGraphPath = join(kbPath, 'system_graph_v2.json');
      if (!existsSync(sysGraphPath)) {
        return { content: [{ type: 'text', text: 'No system graph found. Build KB first.' }] };
      }
      const sysGraph = JSON.parse(readFileSync(sysGraphPath, 'utf-8'));
      const edges = sysGraph.edges ?? [];
      const repo = args.repo as string | undefined;

      const relevant = repo
        ? edges.filter((e: any) => (e.source ?? '').startsWith(repo + '::') || (e.target ?? '').startsWith(repo + '::'))
        : edges;

      const crossRepo = relevant.filter((e: any) => {
        const src = (e.source ?? '').split('::')[0];
        const tgt = (e.target ?? '').split('::')[0];
        return src && tgt && src !== tgt;
      });

      if (crossRepo.length === 0) {
        return { content: [{ type: 'text', text: repo ? `No cross-repo edges found for "${repo}"` : 'No cross-repo edges found' }] };
      }

      const text = crossRepo.slice(0, 50).map((e: any) => {
        const attrs = e.attributes ?? {};
        return `- ${(e.source ?? '').split('::')[0]} → ${(e.target ?? '').split('::')[0]} (${attrs.relation ?? attrs.type ?? 'edge'})`;
      }).join('\n');

      return { content: [{ type: 'text', text: `# Cross-Repo Edges${repo ? ` for ${repo}` : ''}\n\n${crossRepo.length} edges found:\n\n${text}${crossRepo.length > 50 ? `\n\n... and ${crossRepo.length - 50} more` : ''}` }] };
    }

    if (name === 'find_callers' || name === 'find_dependencies') {
      const funcName = args.function as string;
      const repoFilter = args.repo as string | undefined;
      const sysGraphPath = join(kbPath, 'system_graph_v2.json');
      if (!existsSync(sysGraphPath)) {
        return { content: [{ type: 'text', text: 'No system graph found.' }] };
      }
      const sysGraph = JSON.parse(readFileSync(sysGraphPath, 'utf-8'));
      const edges = sysGraph.edges ?? [];

      // Find nodes matching the function name
      const matchingNodes = (sysGraph.nodes ?? []).filter((n: any) => {
        const label = n.attributes?.label ?? n.key ?? '';
        const matchesName = label.includes(funcName) || (n.key ?? '').includes(funcName);
        const matchesRepo = !repoFilter || (n.key ?? '').startsWith(repoFilter + '::');
        return matchesName && matchesRepo;
      });

      if (matchingNodes.length === 0) {
        return { content: [{ type: 'text', text: `No entity found matching "${funcName}"${repoFilter ? ` in ${repoFilter}` : ''}` }] };
      }

      const nodeKeys = new Set(matchingNodes.map((n: any) => n.key));
      let results: any[];

      if (name === 'find_callers') {
        // Incoming edges — who calls this function?
        results = edges.filter((e: any) => nodeKeys.has(e.target)).map((e: any) => e.source);
      } else {
        // Outgoing edges — what does this function call?
        results = edges.filter((e: any) => nodeKeys.has(e.source)).map((e: any) => e.target);
      }

      const unique = [...new Set(results)].slice(0, 30);
      const direction = name === 'find_callers' ? 'Callers of' : 'Dependencies of';

      return { content: [{ type: 'text', text: `# ${direction} "${funcName}"\n\n${unique.length} found:\n${unique.map((r: string) => `- \`${r}\``).join('\n')}` }] };
    }

    if (name === 'impact_analysis') {
      const file = args.file as string;
      const repo = args.repo as string;
      const entity = args.entity as string | undefined;

      const sysGraphPath = join(kbPath, 'system_graph_v2.json');
      if (!existsSync(sysGraphPath)) {
        return { content: [{ type: 'text', text: 'No system graph found.' }] };
      }
      const sysGraph = JSON.parse(readFileSync(sysGraphPath, 'utf-8'));
      const edges = sysGraph.edges ?? [];
      const nodes = sysGraph.nodes ?? [];

      // Find all nodes in this file
      const fileNodes = nodes.filter((n: any) => {
        const key = n.key ?? '';
        const matchesFile = key.includes(`${repo}::${file}::`);
        const matchesEntity = !entity || key.includes(entity);
        return matchesFile && matchesEntity;
      });

      const nodeKeys = new Set(fileNodes.map((n: any) => n.key));

      // Find all incoming edges (who depends on entities in this file)
      const dependents = edges.filter((e: any) => nodeKeys.has(e.target) && !nodeKeys.has(e.source));
      const dependentRepos = new Set(dependents.map((e: any) => (e.source ?? '').split('::')[0]));

      const text = [
        `# Impact Analysis: ${repo}/${file}${entity ? `::${entity}` : ''}`,
        '',
        `## Entities in scope: ${fileNodes.length}`,
        ...fileNodes.slice(0, 20).map((n: any) => `- \`${n.key}\``),
        '',
        `## Dependents: ${dependents.length} edges from ${dependentRepos.size} repos`,
        ...dependents.slice(0, 30).map((e: any) => `- \`${e.source}\` → \`${e.target}\` (${(e.attributes ?? {}).relation ?? 'edge'})`),
        dependents.length > 30 ? `\n... and ${dependents.length - 30} more` : '',
        '',
        `## Affected repos: ${[...dependentRepos].join(', ') || 'none'}`,
      ].join('\n');

      return { content: [{ type: 'text', text }] };
    }

    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Graph tool error: ${msg}` }] };
  }
}
