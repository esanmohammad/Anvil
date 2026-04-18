// Section H — ff-hook CLI entrypoint
import { Command } from 'commander';
import { formatCommand } from './commands/format.js';
import { lintCommand } from './commands/lint.js';
import { conventionCommand } from './commands/convention.js';
import { checkCommand } from './commands/check.js';

export function createHookCli(): Command {
  const program = new Command();

  program
    .name('ff-hook')
    .description('Anvil post-hook convention enforcement')
    .version('0.1.0');

  program.addCommand(formatCommand);
  program.addCommand(lintCommand);
  program.addCommand(conventionCommand);
  program.addCommand(checkCommand);

  return program;
}

// Allow direct execution
const isMain = process.argv[1]?.endsWith('cli.js') || process.argv[1]?.endsWith('cli.ts');
if (isMain) {
  const cli = createHookCli();
  cli.parse();
}

export { formatCommand, lintCommand, conventionCommand, checkCommand };
