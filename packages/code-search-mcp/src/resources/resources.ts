/**
 * MCP Resources — expose repos, profiles, graphs as readable resources.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ServerContext } from '../server.js';
import { getKnowledgeBasePath } from '../core/config.js';
import { loadAllProfiles } from '../core/repo-profiler.js';
import { loadProfile } from '../core/repo-profiler.js';

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
      const graphPath = join(kbPath, 'system_graph_v2.json');
      if (!existsSync(graphPath)) {
        return { contents: [{ uri, mimeType: 'application/json', text: '{"nodes":[],"edges":[]}' }] };
      }
      return {
        contents: [{
          uri,
          mimeType: 'application/json',
          text: readFileSync(graphPath, 'utf-8'),
        }],
      };
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
