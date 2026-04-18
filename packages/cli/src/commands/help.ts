// Comprehensive help text — Wave 9, Section F
// Provides detailed --help text for all commands with examples

export interface CommandHelp {
  name: string;
  description: string;
  usage: string;
  examples: string[];
  options?: string[];
}

export const COMMAND_HELP: CommandHelp[] = [
  {
    name: 'run',
    description: 'Run the full Anvil pipeline for a feature',
    usage: 'ff run <project> "<feature description>"',
    examples: [
      'ff run backend "Add rate limiting to SMTP endpoint"',
      'ff run backend "Fix memory leak in connection pool" --no-clarify',
      'ff run backend "Add new REST endpoint" --skip-ship',
    ],
    options: [
      '--no-clarify    Skip the clarification stage',
      '--skip-ship     Skip the shipping stage',
      '--answers <f>   Pre-filled answers file for clarification',
    ],
  },
  {
    name: 'fix',
    description: 'Auto-fix a bug using an abbreviated pipeline (skip clarify/requirements/spec)',
    usage: 'ff fix <project> "<bug description>"',
    examples: [
      'ff fix backend "SMTP connection drops after 30s idle"',
      'ff fix backend "NPE in UserService.getProfile" --branch-prefix hotfix',
    ],
    options: [
      '--branch-prefix <p>  Branch name prefix (default: "fix")',
      '--no-pr               Skip PR creation',
    ],
  },
  {
    name: 'review',
    description: 'Review uncommitted code changes across project repositories',
    usage: 'ff review <project>',
    examples: [
      'ff review backend',
      'ff review backend --conventions',
    ],
    options: [
      '--conventions   Also check against convention rules',
    ],
  },
  {
    name: 'status',
    description: 'Show running pipelines, active sandboxes, and pending PRs',
    usage: 'ff status',
    examples: [
      'ff status',
      'ff status --project backend',
    ],
    options: [
      '--project <s>   Filter by project name',
    ],
  },
  {
    name: 'stats',
    description: 'Show Anvil statistics with filters',
    usage: 'ff stats',
    examples: [
      'ff stats',
      'ff stats --project backend',
      'ff stats --since 2024-01-01 --until 2024-06-30',
    ],
    options: [
      '--project <s>   Filter by project',
      '--since <date>  Show runs since date (ISO)',
      '--until <date>  Show runs until date (ISO)',
    ],
  },
  {
    name: 'learn',
    description: 'Learn conventions from a project codebase (CI, tests, run history)',
    usage: 'ff learn <project>',
    examples: [
      'ff learn backend',
      'ff learn backend --skip-ci --skip-runs',
    ],
    options: [
      '--skip-ci      Skip CI config scanning',
      '--skip-tests   Skip test pattern scanning',
      '--skip-runs    Skip past run analysis',
    ],
  },
  {
    name: 'init',
    description: 'Initialize a new Anvil workspace',
    usage: 'ff init',
    examples: ['ff init'],
  },
  {
    name: 'doctor',
    description: 'Check project prerequisites and configuration',
    usage: 'ff doctor',
    examples: ['ff doctor'],
  },
  {
    name: 'project',
    description: 'Manage project definitions',
    usage: 'ff project <subcommand>',
    examples: [
      'ff project list',
      'ff project show backend',
    ],
  },
  {
    name: 'resume',
    description: 'Resume a failed or cancelled pipeline run',
    usage: 'ff resume <run-id>',
    examples: ['ff resume abc123'],
  },
  {
    name: 'retry',
    description: 'Retry a failed pipeline run from the failed stage',
    usage: 'ff retry <run-id>',
    examples: ['ff retry abc123'],
  },
  {
    name: 'cancel',
    description: 'Cancel a running pipeline',
    usage: 'ff cancel <run-id>',
    examples: ['ff cancel abc123'],
  },
  {
    name: 'runs',
    description: 'List past pipeline runs',
    usage: 'ff runs',
    examples: [
      'ff runs',
      'ff runs --project backend',
    ],
  },
  {
    name: 'memory',
    description: 'Manage the memory store',
    usage: 'ff memory <subcommand>',
    examples: [
      'ff memory list',
      'ff memory add "Always use connection pooling"',
    ],
  },
  {
    name: 'conventions',
    description: 'Show or manage conventions for a project',
    usage: 'ff conventions <project>',
    examples: ['ff conventions backend'],
  },
  {
    name: 'ship',
    description: 'Ship a completed pipeline run (create PRs)',
    usage: 'ff ship <run-id>',
    examples: ['ff ship abc123'],
  },
  {
    name: 'sandbox',
    description: 'Manage development sandboxes',
    usage: 'ff sandbox <subcommand>',
    examples: [
      'ff sandbox create backend',
      'ff sandbox list',
      'ff sandbox destroy abc',
    ],
  },
];

/**
 * Get help text for a specific command.
 */
export function getCommandHelp(name: string): CommandHelp | undefined {
  return COMMAND_HELP.find((h) => h.name === name);
}

/**
 * Format all commands as a help overview string.
 */
export function formatHelpOverview(): string {
  const lines: string[] = [];

  lines.push('Anvil — AI-powered development pipeline');
  lines.push('');
  lines.push('USAGE');
  lines.push('  ff <command> [options]');
  lines.push('');
  lines.push('COMMANDS');

  const maxNameLen = Math.max(...COMMAND_HELP.map((h) => h.name.length));
  for (const cmd of COMMAND_HELP) {
    const padded = cmd.name.padEnd(maxNameLen + 2);
    lines.push(`  ${padded}${cmd.description}`);
  }

  lines.push('');
  lines.push('Run "ff <command> --help" for more information on a specific command.');

  return lines.join('\n');
}

/**
 * Format detailed help for a single command.
 */
export function formatCommandHelp(help: CommandHelp): string {
  const lines: string[] = [];

  lines.push(`ff ${help.name} — ${help.description}`);
  lines.push('');
  lines.push('USAGE');
  lines.push(`  ${help.usage}`);
  lines.push('');

  if (help.options && help.options.length > 0) {
    lines.push('OPTIONS');
    for (const opt of help.options) {
      lines.push(`  ${opt}`);
    }
    lines.push('');
  }

  lines.push('EXAMPLES');
  for (const ex of help.examples) {
    lines.push(`  $ ${ex}`);
  }

  return lines.join('\n');
}
