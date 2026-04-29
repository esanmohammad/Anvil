import { Command } from 'commander';
import { info, warn } from '../logger.js';
import { createMemoryStore } from '../memory/index.js';
import type { MemoryNamespace } from '@anvil/memory-core';
import pc from 'picocolors';

const VALID_SCOPES = new Set<MemoryNamespace['scope']>([
  'global',
  'user',
  'project',
  'repo',
]);

export const memoryCommand = new Command('memory')
  .description('Show or manage Anvil memory')
  .argument('[project]', 'Optional project to scope memory')
  .option('--tag <tag>', 'Filter by tag')
  .option('--search <query>', 'Search memory content')
  .option('--limit <n>', 'Max entries to show', '20')
  .option('--clear', 'Clear all memory for project')
  .option(
    '--scope <scope>',
    'Namespace scope: global | user | project | repo (overrides positional [project])',
  )
  .option('--user-id <id>', 'User id (required when --scope=user|repo)')
  .option('--repo-id <id>', 'Repo id (required when --scope=repo)')
  .action((project: string | undefined, opts: Record<string, unknown>) => {
    const namespace = resolveNamespaceFromOpts(project, opts);
    if (!namespace) {
      warn('invalid --scope / id combination — see `anvil memory --help`');
      process.exitCode = 1;
      return;
    }
    const store = createMemoryStore(namespace);

    const label = formatNamespaceLabel(namespace);

    if (opts.clear) {
      store.clear();
      info(`Memory cleared for ${label}.`);
      return;
    }

    const limit = Number(opts.limit) || 20;
    let entries = store.query({
      tags: opts.tag ? [opts.tag as string] : undefined,
      search: opts.search as string | undefined,
      limit,
    });

    if (entries.length === 0) {
      info('No memory entries found.');
      return;
    }

    console.log('');
    console.log(pc.bold(`Memory (${label})`));
    console.log(pc.dim('─'.repeat(60)));

    for (const entry of entries) {
      const tags = entry.tags?.length ? pc.dim(` [${entry.tags.join(', ')}]`) : '';
      console.log(`  ${pc.blue(entry.id)}${tags}`);
      console.log(`    ${entry.content.slice(0, 120)}`);
    }

    console.log('');
    info(`${entries.length} entries shown.`);
  });

function resolveNamespaceFromOpts(
  project: string | undefined,
  opts: Record<string, unknown>,
): MemoryNamespace | null {
  const scope = opts.scope as MemoryNamespace['scope'] | undefined;
  const userId = opts.userId as string | undefined;
  const repoId = opts.repoId as string | undefined;

  if (scope) {
    if (!VALID_SCOPES.has(scope)) return null;
    if (scope === 'global') return { scope: 'global' };
    if (scope === 'user') return userId ? { scope: 'user', userId } : null;
    if (scope === 'project') {
      const projectId = project ?? (opts.projectId as string | undefined);
      return projectId ? { scope: 'project', projectId } : null;
    }
    if (scope === 'repo') {
      const projectId = project ?? (opts.projectId as string | undefined);
      return projectId && repoId ? { scope: 'repo', projectId, repoId } : null;
    }
  }

  // Legacy default: positional project arg → project scope; absence → global.
  return project ? { scope: 'project', projectId: project } : { scope: 'global' };
}

function formatNamespaceLabel(ns: MemoryNamespace): string {
  switch (ns.scope) {
    case 'global':
      return 'global';
    case 'user':
      return `user/${ns.userId}`;
    case 'project':
      return `project/${ns.projectId}`;
    case 'repo':
      return `repo/${ns.projectId}/${ns.repoId}`;
  }
}
