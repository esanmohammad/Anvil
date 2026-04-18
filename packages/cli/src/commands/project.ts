import { Command } from 'commander';
import { createStubCommand } from '../stub.js';

export const projectCommand = new Command('project')
  .description('Manage Anvil projects')
  .addCommand(createStubCommand('list', 'List all configured projects'))
  .addCommand(createStubCommand('setup', 'Set up a new project'))
  .addCommand(createStubCommand('refresh', 'Refresh project configuration'))
  .addCommand(createStubCommand('status', 'Show project status'));
