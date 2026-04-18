#!/usr/bin/env node

import { Command } from 'commander';
import { getVersion } from './version.js';
import { registerGlobalFlags } from './flags.js';
import { initCommand } from './commands/init.js';
import { doctorCommand } from './commands/doctor.js';
import { dashboardCommand } from './commands/dashboard.js';

const program = new Command();

program
  .name('anvil')
  .version(getVersion())
  .description('Anvil — AI-powered development pipeline\n\nMVP 1: Use the dashboard for full pipeline experience.\nCLI commands coming in a future release.');

registerGlobalFlags(program);

// ── MVP 1 — Active commands ──────────────────────────────────────────
program.addCommand(initCommand);
program.addCommand(doctorCommand);
program.addCommand(dashboardCommand);

// ── Future CLI commands (disabled for MVP 1) ─────────────────────────
const comingSoon = (name: string, desc: string) => {
  const cmd = new Command(name);
  cmd.description(`${desc} [coming soon]`);
  cmd.action(() => {
    console.log(`\n  anvil ${name} is coming in a future release.\n`);
    console.log(`  For now, use the dashboard:\n`);
    console.log(`    anvil dashboard\n`);
  });
  return cmd;
};

program.addCommand(comingSoon('run', 'Run a feature pipeline'));
program.addCommand(comingSoon('fix', 'Fix a bug'));
program.addCommand(comingSoon('review', 'Review code'));
program.addCommand(comingSoon('resume', 'Resume a pipeline'));
program.addCommand(comingSoon('status', 'Show pipeline status'));
program.addCommand(comingSoon('runs', 'List pipeline runs'));
program.addCommand(comingSoon('cancel', 'Cancel a running pipeline'));
program.addCommand(comingSoon('ship', 'Ship changes and create PRs'));
program.addCommand(comingSoon('memory', 'Manage project memory'));
program.addCommand(comingSoon('search', 'Search the knowledge base'));
program.addCommand(comingSoon('learn', 'Learn conventions from codebase'));
program.addCommand(comingSoon('plan', 'Generate a feature plan'));
program.addCommand(comingSoon('diff', 'AI-powered diff analysis'));
program.addCommand(comingSoon('test-gen', 'Generate tests'));
program.addCommand(comingSoon('watch', 'Watch for changes'));
program.addCommand(comingSoon('team', 'Team collaboration'));

// Default action — launch dashboard
if (process.argv.length <= 2) {
  console.log(`
  Welcome to Anvil v${getVersion()}

  Start the dashboard:
    anvil dashboard

  Initialize a new project:
    anvil init

  Check your setup:
    anvil doctor
`);
} else {
  program.parse();
}

export { program };
