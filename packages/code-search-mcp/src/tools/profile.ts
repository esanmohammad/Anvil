/**
 * Profile tools — repo profiles, repo listing.
 */

import type { ServerContext } from '../server.js';
import { loadAllProfiles, loadProfile, isLlmAvailable } from '@esankhan3/anvil-knowledge-core';
import { resolvedKnowledgeConfig } from '../core/env-config.js';
import { discoverRepos } from '@esankhan3/anvil-knowledge-core';
import { toolError, toolText, validateArgs, type InputSchema, type ToolResult } from './validate.js';

/** Why a repo has no profile: profiles come from indexing, and only with an LLM. */
export function missingProfileText(repo: string): string {
  return isLlmAvailable()
    ? `No profile for "${repo}" yet. Profiles are generated during indexing, so it appears after the next index run (or check the name with list_repos).`
    : `No profile for "${repo}": repo profiles are generated during indexing only when an LLM is configured, and LLM mode is "none".`;
}

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
          repo: { type: 'string', minLength: 1, description: 'Repository name' },
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
): Promise<ToolResult | null> {
  const schema = registerProfileTools().find((t) => t.name === name)?.inputSchema as InputSchema | undefined;
  if (!schema) return null;
  const invalid = validateArgs(schema, args);
  if (invalid) return toolError(`${name}: ${invalid}`);

  try {
    if (name === 'list_repos') {
      const profiles = await loadAllProfiles(ctx.projectName, resolvedKnowledgeConfig());
      if (profiles.length === 0) {
        // Fall back to discovering repos from directory
        if (ctx.directoryPath) {
          const repos = discoverRepos(ctx.directoryPath);
          const text = repos.map(r => `- **${r.name}** (${r.language})`).join('\n');
          return { content: [{ type: 'text', text: `# Repos (${repos.length}, not yet profiled)\n\n${text}` }] };
        }
        return toolText('No repos indexed yet.');
      }

      const text = profiles.map(p =>
        `- **${p.name}** — ${p.role} | ${p.domain} | ${p.description}`
      ).join('\n');

      return { content: [{ type: 'text', text: `# Indexed Repos (${profiles.length})\n\n${text}` }] };
    }

    if (name === 'get_repo_profile') {
      const repo = args.repo as string;
      const profile = await loadProfile(ctx.projectName, repo, resolvedKnowledgeConfig());
      if (!profile) return toolText(missingProfileText(repo));

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
    return toolError(`Profile tool error: ${msg}`);
  }
}
