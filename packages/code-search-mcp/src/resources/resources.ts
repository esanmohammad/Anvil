/**
 * MCP Resources — expose repos, profiles, graphs as readable resources.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerContext } from '../server.js';
import { getKnowledgeBasePath, openSystemGraphStore } from '@esankhan3/anvil-knowledge-core';
import { loadAllProfiles } from '@esankhan3/anvil-knowledge-core';
import { loadProfile } from '@esankhan3/anvil-knowledge-core';

export function registerResources(ctx: ServerContext) {
  return [
    {
      uri: `code-search://repos`,
      name: 'All Repos',
      description: `List of all repos in project "${ctx.projectName}"`,
      mimeType: 'application/json',
    },
    {
      uri: `code-search://system-graph`,
      name: 'System Graph',
      description: 'Unified knowledge graph with cross-repo edges',
      mimeType: 'application/json',
    },
  ];
}

export async function handleResource(
  uri: string,
  ctx: ServerContext,
): Promise<{ contents: Array<{ uri: string; mimeType: string; text: string }> }> {
  try {
    // (imported at top)
    const kbPath = getKnowledgeBasePath(ctx.projectName);

    if (uri === 'code-search://repos') {
      // (imported at top)
      const profiles = loadAllProfiles(ctx.projectName);
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(profiles, null, 2),
        }],
      };
    }

    if (uri === 'code-search://system-graph') {
      // The merged graph is now a slice-queryable SQLite store (system_graph.sqlite).
      // Dumping every node+edge would reintroduce the org-scale V8 string-length
      // OOM the sqlite migration removed, so serve a bounded overview — the
      // highest-degree nodes + cross-repo edges + totals. Full traversal is via
      // the graph tools (search_graph, find_callers, impact_analysis, …).
      const store = await openSystemGraphStore(kbPath);
      if (!store) {
        return { contents: [{ uri, mimeType: 'application/json', text: '{"nodes":[],"crossRepoEdges":[],"totals":{"nodes":0,"crossRepoEdges":0}}' }] };
      }
      try {
        const NODE_LIMIT = 200;
        const EDGE_LIMIT = 200;
        const { rows: nodes, total: nodeTotal } = store.searchNodes({ minDegree: 0 }, NODE_LIMIT);
        const { edges: crossRepoEdges, total: edgeTotal } = store.crossRepoEdges(undefined, EDGE_LIMIT);
        const payload = {
          nodes,
          crossRepoEdges,
          totals: { nodes: nodeTotal, crossRepoEdges: edgeTotal },
          truncated: nodeTotal > nodes.length || edgeTotal > crossRepoEdges.length,
          note: 'Bounded overview (top nodes by degree + cross-repo edges). Use the graph tools for full traversal.',
        };
        return { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(payload, null, 2) }] };
      } finally {
        store.close();
      }
    }

    // Dynamic resource: code-search://repo/{name}/profile
    const profileMatch = uri.match(/^code-search:\/\/repo\/([^/]+)\/profile$/);
    if (profileMatch) {
      // (imported at top)
      const profile = loadProfile(ctx.projectName, profileMatch[1]);
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: profile ? JSON.stringify(profile, null, 2) : '{}',
        }],
      };
    }

    // Dynamic resource: code-search://repo/{name}/graph
    const graphMatch = uri.match(/^code-search:\/\/repo\/([^/]+)\/graph$/);
    if (graphMatch) {
      const graphPath = join(kbPath, graphMatch[1], 'graph.json');
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: existsSync(graphPath) ? readFileSync(graphPath, 'utf-8') : '{"nodes":[],"links":[]}',
        }],
      };
    }

    return { contents: [{ uri, mimeType: 'text/plain', text: `Unknown resource: ${uri}` }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { contents: [{ uri, mimeType: 'text/plain', text: `Error: ${msg}` }] };
  }
}
