// anvil watch — watch for file changes and auto-run lint/test/build

import { Command } from 'commander';
import { watch as fsWatch } from 'node:fs';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getAnvilHome } from '../home.js';
import { info, success, warn, error } from '../logger.js';
import pc from 'picocolors';

interface RepoConfig {
  name: string;
  path: string;
  commands?: {
    build?: string;
    test?: string;
    lint?: string;
  };
}

function loadProjectRepos(projectName: string): RepoConfig[] {
  const home = getAnvilHome();
  const configPath = join(home, 'projects', projectName, 'factory.yaml');
  if (!existsSync(configPath)) return [];

  const raw = readFileSync(configPath, 'utf-8');
  const repos: RepoConfig[] = [];
  let workspace = '';

  // Parse workspace
  const wsMatch = raw.match(/^workspace:\s+(.+)$/m);
  if (wsMatch) {
    workspace = wsMatch[1].replace(/^["']|["']$/g, '').trim().replace(/^~/, homedir());
  }

  // Parse repos
  const lines = raw.split('\n');
  let currentRepo: Partial<RepoConfig> | null = null;
  let inCommands = false;

  const flush = () => {
    if (currentRepo?.name) {
      const repoPath = currentRepo.path?.startsWith('/')
        ? currentRepo.path
        : join(workspace, (currentRepo.path || currentRepo.name).replace(/^\.\//, ''));
      repos.push({
        name: currentRepo.name,
        path: repoPath,
        commands: currentRepo.commands,
      });
    }
    currentRepo = null;
    inCommands = false;
  };

  let inRepos = false;
  for (const line of lines) {
    const stripped = line.trimEnd();
    if (/^\s*#/.test(stripped) || /^\s*$/.test(stripped)) continue;
    const indent = stripped.length - stripped.trimStart().length;

    if (indent === 0) {
      flush();
      inRepos = false;
      if (/^repos:\s*$/.test(stripped)) inRepos = true;
      continue;
    }

    if (inRepos) {
      const repoStart = stripped.match(/^\s{2,4}-\s+name:\s+(.+)/);
      if (repoStart) {
        flush();
        currentRepo = { name: repoStart[1].trim(), commands: {} };
        continue;
      }
      if (currentRepo) {
        if (/^\s{4,6}commands:\s*$/.test(stripped)) {
          inCommands = true;
          continue;
        }
        const kv = stripped.match(/^\s{4,8}(\w[\w_-]*):\s+(.+)$/);
        if (kv) {
          const val = kv[2].replace(/^["']|["']$/g, '').trim();
          if (!inCommands && kv[1] === 'path') currentRepo.path = val;
          if (inCommands) {
            if (!currentRepo.commands) currentRepo.commands = {};
            (currentRepo.commands as any)[kv[1]] = val;
          }
        }
      }
    }
  }
  flush();

  return repos;
}

function runCommand(cmd: string, cwd: string, label: string): boolean {
  try {
    execSync(cmd, { cwd, timeout: 60_000, stdio: ['pipe', 'pipe', 'pipe'] });
    success(`${label}: passed`);
    return true;
  } catch (err: any) {
    const output = err.stderr?.toString()?.slice(0, 500) || err.message?.slice(0, 200) || '';
    error(`${label}: failed`);
    if (output) process.stderr.write(pc.dim(output) + '\n');
    return false;
  }
}

export const watchCommand = new Command('watch')
  .description('Watch for file changes and auto-run lint/test/build')
  .argument('[project]', 'Project to watch')
  .option('--test', 'Run tests on change')
  .option('--lint', 'Run lint on change')
  .option('--build', 'Run build on change')
  .action(async (projectName?: string, opts?: { test?: boolean; lint?: boolean; build?: boolean }) => {
    if (!projectName) {
      // Try to find projects
      const home = getAnvilHome();
      const projectsDir = join(home, 'projects');
      if (existsSync(projectsDir)) {
        const names = readdirSync(projectsDir).filter((n) => !n.startsWith('.'));
        if (names.length === 1) {
          projectName = names[0];
        } else if (names.length > 1) {
          error(`Multiple projects found. Specify one: ${names.join(', ')}`);
          process.exitCode = 1;
          return;
        }
      }
      if (!projectName) {
        error('No project specified and no projects found.');
        process.exitCode = 1;
        return;
      }
    }

    const repos = loadProjectRepos(projectName);
    if (repos.length === 0) {
      error(`No repos found for project "${projectName}".`);
      process.exitCode = 1;
      return;
    }

    // Default: run all if none specified
    const runLint = opts?.lint ?? (!opts?.test && !opts?.build);
    const runTest = opts?.test ?? (!opts?.lint && !opts?.build);
    const runBuild = opts?.build ?? false;

    info(`Watching ${repos.length} repo(s) for ${projectName}...`);
    for (const repo of repos) {
      info(`  ${repo.name}: ${repo.path}`);
    }
    process.stderr.write(pc.dim('Press Ctrl+C to stop.\n\n'));

    // Debounce map
    const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();

    for (const repo of repos) {
      if (!existsSync(repo.path)) {
        warn(`Repo path not found: ${repo.path}`);
        continue;
      }

      try {
        fsWatch(repo.path, { recursive: true }, (_event, filename) => {
          if (!filename) return;
          // Skip hidden files, node_modules, dist, .git
          if (
            filename.startsWith('.') ||
            filename.includes('node_modules') ||
            filename.includes('/dist/') ||
            filename.includes('.git/')
          ) return;

          const key = repo.name;
          const existing = debounceTimers.get(key);
          if (existing) clearTimeout(existing);

          debounceTimers.set(key, setTimeout(() => {
            debounceTimers.delete(key);
            process.stderr.write(`\n${pc.cyan('⟳')} Change detected in ${pc.bold(repo.name)} (${filename})\n`);

            if (runLint && repo.commands?.lint) {
              runCommand(repo.commands.lint, repo.path, `${repo.name} lint`);
            }
            if (runTest && repo.commands?.test) {
              runCommand(repo.commands.test, repo.path, `${repo.name} test`);
            }
            if (runBuild && repo.commands?.build) {
              runCommand(repo.commands.build, repo.path, `${repo.name} build`);
            }
          }, 500));
        });
      } catch (err) {
        warn(`Could not watch ${repo.name}: ${err}`);
      }
    }

    // Keep process alive
    await new Promise(() => {});
  });
