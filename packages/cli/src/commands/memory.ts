import { Command } from 'commander';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { getFFDirs } from '../home.js';
import { info } from '../logger.js';
import { MemoryStore } from '../memory/index.js';
import pc from 'picocolors';

export const memoryCommand = new Command('memory')
  .description('Show or manage Anvil memory')
  .argument('[project]', 'Optional project to scope memory')
  .option('--tag <tag>', 'Filter by tag')
  .option('--search <query>', 'Search memory content')
  .option('--limit <n>', 'Max entries to show', '20')
  .option('--clear', 'Clear all memory for project')
  .action((project: string | undefined, opts: Record<string, unknown>) => {
    const anvilDirs = getFFDirs();
    const memoryPath = join(anvilDirs.memory, project ?? '_global');
    mkdirSync(memoryPath, { recursive: true });
    const store = new MemoryStore({ path: memoryPath, maxSizeBytes: 10 * 1024 * 1024, defaultTTLDays: 90 });

    if (opts.clear) {
      store.clear();
      info(`Memory cleared${project ? ` for ${project}` : ''}.`);
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
    console.log(pc.bold(`Memory${project ? ` (${project})` : ''}`));
    console.log(pc.dim('─'.repeat(60)));

    for (const entry of entries) {
      const tags = entry.tags?.length ? pc.dim(` [${entry.tags.join(', ')}]`) : '';
      console.log(`  ${pc.blue(entry.id)}${tags}`);
      console.log(`    ${entry.content.slice(0, 120)}`);
    }

    console.log('');
    info(`${entries.length} entries shown.`);
  });
