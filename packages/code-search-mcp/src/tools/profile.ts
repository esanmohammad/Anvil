/**
 * Profile tools — repo profiles, repo listing.
 */

import type { ServerContext } from '../server.js';
import { loadAllProfiles, loadProfile } from '../core/repo-profiler.js';
import { discoverRepos } from '../core/indexer.js';

export function registerProfileTools() {
  return [
    {
      name: 'list_repos',
      description: 'List all indexed repos with their role, domain, and description.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'get_repo_profile',
      description: 'Get the LLM-generated profile for a repo — role, domain, tech stack, exposed/consumed endpoints.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          repo: { type: 'string', description: 'Repository name' },
        },
        required: ['repo'],
      },
    },
  ];
}

export async function handleProfileTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ServerContext,
): Promise<{ content: Array<{ type: string; text: string }> } | null> {
  if (!['list_repos', 'get_repo_profile'].includes(name)) return null;

  try {
    // imported at top

    if (name === 'list_repos') {
      const profiles = loadAllProfiles(ctx.projectName);
      if (profiles.length === 0) {
        // Fall back to discovering repos from directory
        if (ctx.directoryPath) {
          // imported at top
          const repos = discoverRepos(ctx.directoryPath);
          const text = repos.map(r => `- **${r.name}** (${r.language})`).join('\n');
          return { content: [{ type: 'text', text: `# Repos (${repos.length}, not yet profiled)\n\n${text}` }] };
        }
        return { content: [{ type: 'text', text: 'No repos found. Run reindex first.' }] };
      }

      const text = profiles.map(p =>
        `- **${p.name}** — ${p.role} | ${p.domain} | ${p.description}`
      ).join('\n');

      return { content: [{ type: 'text', text: `# Indexed Repos (${profiles.length})\n\n${text}` }] };
    }

    if (name === 'get_repo_profile') {
      const repo = args.repo as string;
      const profile = loadProfile(ctx.projectName, repo);
      if (!profile) {
        return { content: [{ type: 'text', text: `No profile found for "${repo}". Run reindex to generate profiles.` }] };
      }

      const lines = [
        `# ${profile.name}`,
        '',
        `**Role:** ${profile.role}`,
        `**Domain:** ${profile.domain}`,
        `**Description:** ${profile.description}`,
        `**Technologies:** ${profile.technologies.join(', ')}`,
        `**Entry points:** ${profile.entryPoints.join(', ')}`,
        '',
      ];

      if (profile.exposes.length > 0) {
        lines.push('## Exposes');
        for (const e of profile.exposes) {
          lines.push(`- **${e.type}:** \`${e.identifier}\` — ${e.description}`);
        }
        lines.push('');
      }

      if (profile.consumes.length > 0) {
        lines.push('## Consumes');
        for (const c of profile.consumes) {
          lines.push(`- **${c.type}:** \`${c.identifier}\` — ${c.description}`);
        }
      }

      return { content: [{ type: 'text', text: lines.join('\n') }] };
    }

    return null;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { content: [{ type: 'text', text: `Profile tool error: ${msg}` }] };
  }
}
