// CLI command: anvil team — team-shared memory and learnings via git-backed store

import { Command } from 'commander';
import { execSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import pc from 'picocolors';
import { info, success, error, warn } from '../logger.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TEAM_DIR = join(homedir(), '.anvil', 'team');
const LEARNINGS_FILE = 'learnings.jsonl';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Learning {
  text: string;
  type: 'convention' | 'pattern' | 'anti-pattern' | 'tip';
  author: string;
  date: string;
  project?: string;
  machine?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getAuthor(): string {
  try {
    return execSync('git config user.name', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

function getMachine(): string {
  try {
    return execSync('hostname', { encoding: 'utf-8' }).trim();
  } catch {
    return 'unknown';
  }
}

function ensureTeamDir(): boolean {
  if (!existsSync(TEAM_DIR)) {
    error('Team memory not initialized. Run: anvil team init <repo-url>');
    return false;
  }
  // Verify it is a git repo
  if (!existsSync(join(TEAM_DIR, '.git'))) {
    error('Team directory exists but is not a git repository.');
    return false;
  }
  return true;
}

function gitInTeam(cmd: string): string {
  return execSync(`git -C "${TEAM_DIR}" ${cmd}`, {
    encoding: 'utf-8',
    timeout: 30_000,
  }).trim();
}

export function readLearnings(): Learning[] {
  const file = join(TEAM_DIR, LEARNINGS_FILE);
  if (!existsSync(file)) return [];
  const raw = readFileSync(file, 'utf-8');
  const items: Learning[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      items.push(JSON.parse(trimmed) as Learning);
    } catch {
      // skip malformed lines
    }
  }
  return items;
}

function formatType(type: string): string {
  switch (type) {
    case 'convention':
      return pc.blue('convention');
    case 'pattern':
      return pc.green('pattern');
    case 'anti-pattern':
      return pc.red('anti-pattern');
    case 'tip':
      return pc.yellow('tip');
    default:
      return pc.dim(type);
  }
}

// ---------------------------------------------------------------------------
// Command: anvil team
// ---------------------------------------------------------------------------

export const teamCommand = new Command('team')
  .description('Team-shared memory and learnings');

// ---------------------------------------------------------------------------
// Subcommand: init
// ---------------------------------------------------------------------------

teamCommand.addCommand(
  new Command('init')
    .description('Initialize team memory repository')
    .argument('<repo-url>', 'Git repository URL for team memory')
    .action(async (repoUrl: string) => {
      if (existsSync(TEAM_DIR)) {
        warn(`Team directory already exists at ${TEAM_DIR}`);
        info('To re-initialize, remove the directory first:');
        info(`  rm -rf ${TEAM_DIR}`);
        return;
      }

      // Ensure parent dir
      const parentDir = join(homedir(), '.anvil');
      if (!existsSync(parentDir)) {
        mkdirSync(parentDir, { recursive: true });
      }

      info(`Cloning team memory from ${pc.cyan(repoUrl)}...`);

      try {
        execSync(`git clone "${repoUrl}" "${TEAM_DIR}"`, {
          encoding: 'utf-8',
          stdio: 'pipe',
          timeout: 60_000,
        });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        error(`Failed to clone repository: ${msg}`);
        return;
      }

      // Ensure learnings file exists
      const learningsPath = join(TEAM_DIR, LEARNINGS_FILE);
      if (!existsSync(learningsPath)) {
        writeFileSync(learningsPath, '', 'utf-8');
        gitInTeam(`add "${LEARNINGS_FILE}"`);
        gitInTeam('commit -m "Initialize learnings file"');
      }

      success(`Team memory initialized at ${TEAM_DIR}`);
      info('Share learnings with: anvil team add "your learning here"');
    }),
);

// ---------------------------------------------------------------------------
// Subcommand: sync
// ---------------------------------------------------------------------------

teamCommand.addCommand(
  new Command('sync')
    .description('Pull latest team memory and push local learnings')
    .action(async () => {
      if (!ensureTeamDir()) return;

      info('Syncing team memory...');

      try {
        const pullOutput = gitInTeam('pull --rebase');
        if (pullOutput && pullOutput !== 'Already up to date.') {
          info(pc.dim(pullOutput));
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        warn(`Pull failed: ${msg}`);
        info('You may need to resolve conflicts manually in ~/.anvil/team/');
        return;
      }

      try {
        gitInTeam('push');
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        warn(`Push failed (may have no remote or nothing to push): ${msg}`);
      }

      success('Team memory synced.');
    }),
);

// ---------------------------------------------------------------------------
// Subcommand: add
// ---------------------------------------------------------------------------

teamCommand.addCommand(
  new Command('add')
    .description('Add a learning to team memory')
    .argument('<text>', 'The learning or convention to share')
    .option('--type <type>', 'Type: convention, pattern, anti-pattern, tip', 'tip')
    .option('--project <name>', 'Associated project name')
    .option('--push', 'Push to remote after committing', false)
    .action(async (text: string, opts: { type: string; project?: string; push: boolean }) => {
      if (!ensureTeamDir()) return;

      const validTypes = ['convention', 'pattern', 'anti-pattern', 'tip'];
      if (!validTypes.includes(opts.type)) {
        error(`Invalid type "${opts.type}". Must be one of: ${validTypes.join(', ')}`);
        return;
      }

      const learning: Learning = {
        text,
        type: opts.type as Learning['type'],
        author: getAuthor(),
        date: new Date().toISOString().slice(0, 10),
        project: opts.project,
        machine: getMachine(),
      };

      const learningsPath = join(TEAM_DIR, LEARNINGS_FILE);
      appendFileSync(learningsPath, JSON.stringify(learning) + '\n', 'utf-8');

      // Auto-commit
      try {
        gitInTeam(`add "${LEARNINGS_FILE}"`);
        const commitMsg = `learning(${opts.type}): ${text.slice(0, 60)}`;
        gitInTeam(`commit -m "${commitMsg.replace(/"/g, '\\"')}"`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        warn(`Auto-commit failed: ${msg}`);
      }

      // Optionally push
      if (opts.push) {
        try {
          gitInTeam('push');
          info('Pushed to remote.');
        } catch {
          warn('Push failed — run "anvil team sync" to push later.');
        }
      }

      success(`Added ${formatType(opts.type)}: ${text}`);
    }),
);

// ---------------------------------------------------------------------------
// Subcommand: list
// ---------------------------------------------------------------------------

teamCommand.addCommand(
  new Command('list')
    .description('Show team learnings')
    .option('--type <type>', 'Filter by type')
    .option('--project <name>', 'Filter by project')
    .option('--limit <n>', 'Show last N entries', '20')
    .action(async (opts: { type?: string; project?: string; limit: string }) => {
      if (!ensureTeamDir()) return;

      let learnings = readLearnings();

      if (opts.type) {
        learnings = learnings.filter((l) => l.type === opts.type);
      }
      if (opts.project) {
        learnings = learnings.filter((l) => l.project === opts.project);
      }

      const limit = parseInt(opts.limit, 10) || 20;
      const display = learnings.slice(-limit);

      if (display.length === 0) {
        info('No learnings found.');
        if (opts.type) info(pc.dim(`  (filtered by type: ${opts.type})`));
        return;
      }

      console.log('');
      console.log(pc.bold(`  Team Learnings (${display.length} of ${learnings.length})`));
      console.log(pc.dim('  ' + '─'.repeat(50)));
      console.log('');

      for (const l of display) {
        const typeTag = formatType(l.type);
        const meta = [
          l.author && pc.dim(l.author),
          l.date && pc.dim(l.date),
          l.project && pc.dim(`[${l.project}]`),
        ]
          .filter(Boolean)
          .join(pc.dim(' · '));

        console.log(`  ${typeTag}  ${l.text}`);
        console.log(`  ${meta}`);
        console.log('');
      }
    }),
);
