/**
 * Project-graph WS routes (Recipe 7 / Phase 1).
 *
 * Migrated:
 *   - build-project-graph — fire-and-forget kickoff. Progress + terminal
 *     status stream through `services.projectGraph.emit(...)`.
 *
 * NOT migrated (reads — stay handler-side):
 *   - get-project-graph-status (knowledge-core readback)
 *   - get-graph-nodes (graph readback)
 */

import { route, type Handler } from './route.js';
import * as Z from './schemas.js';

export function projectGraphRoutes(): Record<string, Handler> {
  return {
    'build-project-graph': route({
      input: Z.BuildProjectGraph,
      handle: (input, deps) => { deps.services.projectGraph.build(input); },
    }),

    /**
     * `get-graph-nodes` — serve graph.json data for the force-graph
     * visualization. Pure FS reads keyed off `<anvilHome>/knowledge-base/<project>`.
     * Two levels:
     *   - 'repo' + repoName → that repo's graph.json
     *   - 'project'         → PROJECT_GRAPH.json (optionally enriched
     *                         with cross-repo edges synthesised from
     *                         `system_graph_v2.json` / `system_graph.json`)
     *                         + per-repo node-count stats.
     *
     * Legacy error path: on a thrown error the handler emits a
     * `{ level, data: { nodes: [], links: [] }, error }` payload — note
     * this uses the originally-requested level, not 'project', so the
     * UI can still parse it. Mirrored below by sending directly on
     * `deps.ws` instead of throwing.
     */
    'get-graph-nodes': route({
      input: Z.GetGraphNodes,
      onParseFail: 'silent',
      handle: async (input, deps) => {
        const { join } = await import('node:path');
        const { existsSync, readFileSync, readdirSync } = await import('node:fs');
        const project = input.project;
        const repo = input.options?.repo ?? '';
        const level = input.options?.level ?? 'project';
        const kbDir = join(deps.extras.anvilHome, 'knowledge-base', project);

        try {
          if (level === 'repo' && repo) {
            const graphPath = join(kbDir, repo, 'graph.json');
            if (existsSync(graphPath)) {
              const graphData = JSON.parse(readFileSync(graphPath, 'utf-8'));
              return { level: 'repo', repo, data: graphData };
            }
            return { level: 'repo', repo, data: { nodes: [], links: [] } };
          }

          const projectGraphPath = join(kbDir, 'PROJECT_GRAPH.json');
          let projectGraph: { relationships?: unknown[] } | null = null;
          if (existsSync(projectGraphPath)) {
            try { projectGraph = JSON.parse(readFileSync(projectGraphPath, 'utf-8')); } catch { /* ok */ }
          }

          const repoStats: Array<{ repoName: string; nodeCount: number }> = [];
          if (existsSync(kbDir)) {
            for (const entry of readdirSync(kbDir)) {
              const entryDir = join(kbDir, entry);
              const metaPath = existsSync(join(entryDir, 'metadata.json'))
                ? join(entryDir, 'metadata.json')
                : join(entryDir, 'index_meta.json');
              const graphPath = join(entryDir, 'graph.json');
              if (existsSync(metaPath) || existsSync(graphPath)) {
                try {
                  let nodeCount = 0;
                  if (existsSync(metaPath)) {
                    const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
                    nodeCount = meta.nodeCount ?? meta.chunkCount ?? 0;
                  }
                  if (existsSync(graphPath) && nodeCount === 0) {
                    const graph = JSON.parse(readFileSync(graphPath, 'utf-8'));
                    nodeCount = graph.nodes?.length ?? 0;
                  }
                  repoStats.push({ repoName: entry, nodeCount });
                } catch { /* skip */ }
              }
            }
          }

          // Enrich projectGraph with cross-repo relationships from the
          // system_graph file (v2 preferred, falls back to v1). Errors
          // here are non-fatal — the UI degrades gracefully.
          const sysGraphPath = existsSync(join(kbDir, 'system_graph_v2.json'))
            ? join(kbDir, 'system_graph_v2.json')
            : join(kbDir, 'system_graph.json');
          if (existsSync(sysGraphPath)) {
            try {
              const sysGraph = JSON.parse(readFileSync(sysGraphPath, 'utf-8'));
              const sysEdges = sysGraph.edges ?? [];
              const repoSet = new Set(repoStats.map((r) => r.repoName));
              const crossRepoEdges: Array<{
                from: string; to: string; type: string;
                description: string; criticality: string; direction: string;
              }> = [];
              const seenEdges = new Set<string>();
              for (const edge of sysEdges) {
                const attrs = edge.attributes ?? edge;
                const rel = attrs.relation ?? attrs.type ?? '';
                const transport = attrs.transport ?? '';
                const srcRepo = (edge.source ?? '').split('::')[0];
                const tgtRepo = (edge.target ?? '').split('::')[0];
                if (srcRepo && tgtRepo && srcRepo !== tgtRepo && repoSet.has(srcRepo) && repoSet.has(tgtRepo)) {
                  const key = `${srcRepo}->${tgtRepo}::${rel || transport}`;
                  if (!seenEdges.has(key)) {
                    seenEdges.add(key);
                    crossRepoEdges.push({
                      from: srcRepo, to: tgtRepo,
                      type: transport ? 'async-event' : rel.includes('http') ? 'sync-http' : 'shared-types',
                      description: transport || rel || 'cross-repo',
                      criticality: 'medium', direction: 'unidirectional',
                    });
                  }
                }
              }
              if (crossRepoEdges.length > 0) {
                if (!projectGraph) projectGraph = { relationships: crossRepoEdges };
                else projectGraph.relationships = [...(projectGraph.relationships ?? []), ...crossRepoEdges];
              }
            } catch { /* non-fatal */ }
          }

          return { level: 'project', projectGraph, repoStats };
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          // Match legacy parity: error payload uses originally-requested
          // `level` (not always 'project').
          deps.ws.send(JSON.stringify({
            type: 'graph-nodes',
            payload: { level, data: { nodes: [], links: [] }, error: message },
          }));
        }
      },
      wireType: 'graph-nodes',
    }),

    'get-project-graph-status': route({
      input: Z.GetProjectGraphStatus,
      onParseFail: 'silent',
      handle: async (input) => {
        const project = input.project ?? '';
        try {
          const { getProjectGraphStatus, loadProjectSummary } = await import('@esankhan3/anvil-knowledge-core');
          const status = getProjectGraphStatus(project);
          const summary = status.exists ? loadProjectSummary(project) : null;
          return { ...status, summary };
        } catch {
          return { exists: false, generatedAt: null, model: null, costUsd: null, summary: null };
        }
      },
      wireType: 'project-graph-status',
    }),
  };
}
