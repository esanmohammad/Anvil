#!/usr/bin/env node

import { Command } from 'commander';
import { getVersion } from './version.js';
import { registerGlobalFlags } from './flags.js';
import { initCommand } from './commands/init.js';
import { doctorCommand } from './commands/doctor.js';
import { dashboardCommand } from './commands/dashboard.js';
import { runReplayCommand } from './commands/run-replay.js';
import { resumeDurableCommand } from './commands/resume-durable.js';
import { browserCommand } from './commands/browser-login.js';
import { sandboxRuntimeCommand } from './commands/sandbox-runtime.js';

const program = new Command();

program
  .name('anvil')
  .version(getVersion())
  .description('Anvil — AI-powered development pipeline\n\nMVP 2: Use the dashboard for full pipeline experience.\nCLI commands coming in a future release.');

registerGlobalFlags(program);

// ── MVP 2 — Active commands ──────────────────────────────────────────
program.addCommand(initCommand);
program.addCommand(doctorCommand);
program.addCommand(dashboardCommand);
program.addCommand(runReplayCommand);
program.addCommand(resumeDurableCommand);
program.addCommand(browserCommand);
program.addCommand(sandboxRuntimeCommand);

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
