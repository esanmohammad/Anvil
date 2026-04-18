import { Command } from 'commander';
import { PERSONA_NAMES } from '../personas/types.js';
import { loadPersonaPrompt } from '../personas/loader.js';
import { validatePersonaPrompt } from '../personas/validator.js';
import { installPersonas } from '../personas/installer.js';
import { getStagesForPersona } from '../personas/stage-map.js';
import { getPersonaPlugins } from '../plugins/catalog.js';
import { log, success, error, info } from '../logger.js';
import pc from 'picocolors';

export const personasCommand = new Command('personas')
  .description('Manage persona prompts')
  .action(async () => {
    log('');
    log(pc.bold('Anvil Personas'));
    log('─'.repeat(60));
    log(
      `  ${'Name'.padEnd(12)} ${'Stages'.padEnd(30)} Plugins`,
    );
    log('─'.repeat(60));

    for (const name of PERSONA_NAMES) {
      const stages = getStagesForPersona(name).join(', ');
      const plugins = getPersonaPlugins(name).length;
      log(`  ${name.padEnd(12)} ${stages.padEnd(30)} ${plugins}`);
    }
    log('');
  });

personasCommand
  .command('show')
  .argument('<name>', 'Persona name')
  .description('Display persona prompt content')
  .action(async (name: string) => {
    try {
      const content = await loadPersonaPrompt(name as any);
      log(content);
    } catch (err: any) {
      error(err.message);
      process.exitCode = 1;
    }
  });

personasCommand
  .command('validate')
  .description('Validate all installed persona prompts')
  .action(async () => {
    let allValid = true;
    for (const name of PERSONA_NAMES) {
      try {
        const content = await loadPersonaPrompt(name);
        const result = validatePersonaPrompt(name, content);
        if (result.valid) {
          success(`${name}: valid`);
        } else {
          error(`${name}: ${result.errors.join(', ')}`);
          allValid = false;
        }
        for (const w of result.warnings) {
          info(`${name}: ${w}`);
        }
      } catch (err: any) {
        error(`${name}: ${err.message}`);
        allValid = false;
      }
    }
    if (!allValid) process.exitCode = 1;
  });

personasCommand
  .command('reset')
  .argument('<name>', 'Persona name to reset')
  .description('Reinstall bundled persona prompt (overwrites customization)')
  .action(async () => {
    const result = await installPersonas(true);
    success(`Reinstalled ${result.installed.length} persona prompts`);
  });
