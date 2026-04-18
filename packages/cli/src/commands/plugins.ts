import { Command } from 'commander';
import { PLUGIN_CATALOG, getPersonaPlugins } from '../plugins/catalog.js';
import { checkPluginAvailability } from '../plugins/availability.js';
import { isValidPersonaName } from '../personas/types.js';
import { log, success, error, info } from '../logger.js';
import pc from 'picocolors';

export const pluginsCommand = new Command('plugins')
  .description('Manage and inspect plugins')
  .action(async () => {
    log('');
    log(pc.bold('Plugin Catalog'));
    log('─'.repeat(60));
    log(`  ${'Name'.padEnd(16)} ${'Version'.padEnd(10)} Capabilities`);
    log('─'.repeat(60));

    for (const [name, plugin] of Object.entries(PLUGIN_CATALOG)) {
      log(
        `  ${name.padEnd(16)} ${plugin.version.padEnd(10)} ${plugin.capabilities.join(', ')}`,
      );
    }
    log(`\n  ${Object.keys(PLUGIN_CATALOG).length} plugins total`);
    log('');
  });

pluginsCommand
  .command('check')
  .description('Check plugin availability')
  .action(async () => {
    const names = Object.keys(PLUGIN_CATALOG);
    const results = await checkPluginAvailability(names);
    for (const r of results) {
      if (r.status === 'available') {
        success(`${r.name}: available`);
      } else {
        error(`${r.name}: ${r.status}`);
      }
    }
  });

pluginsCommand
  .command('show')
  .argument('<persona>', 'Persona name')
  .description('Show plugins for a persona')
  .action(async (persona: string) => {
    if (!isValidPersonaName(persona)) {
      error(`Unknown persona: ${persona}`);
      process.exitCode = 1;
      return;
    }
    const plugins = getPersonaPlugins(persona);
    log(`\nPlugins for ${pc.bold(persona)}:`);
    for (const p of plugins) {
      const plugin = PLUGIN_CATALOG[p];
      info(`${p} (v${plugin?.version || '?'}): ${plugin?.description || 'unknown'}`);
    }
    log('');
  });
