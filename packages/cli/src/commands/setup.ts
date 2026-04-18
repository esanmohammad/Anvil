import { Command } from 'commander';
import { execSync, execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { getFFHome } from '../home.js';
import pc from 'picocolors';

// ── Minimal config reading ────────────────────────────────────────────────

interface RepoEntry {
  name: string;
  path: string;
  github?: string;
  installCmd?: string;
}

interface ProjectConfig {
  project: string;
  workspace?: string;
  repos: RepoEntry[];
}

function findProjectConfigs(): Array<{ name: string; configPath: string }> {
  const home = getFFHome();
  const entries: Array<{ name: string; configPath: string }> = [];

  const projectsDir = join(home, 'projects');
  if (existsSync(projectsDir)) {
    try {
      for (const name of readdirSync(projectsDir)) {
        if (name.startsWith('.')) continue;
        const yamlPath = join(projectsDir, name, 'factory.yaml');
        if (existsSync(yamlPath)) {
          entries.push({ name, configPath: yamlPath });
        }
      }
    } catch { /* ignore */ }
  }

  const legacyDir = join(home, 'projects');
  if (existsSync(legacyDir)) {
    try {
      for (const name of readdirSync(legacyDir)) {
        if (name.startsWith('.')) continue;
        if (entries.some((e) => e.name === name)) continue;
        const yamlPath = join(legacyDir, name, 'project.yaml');
        if (existsSync(yamlPath)) {
          entries.push({ name, configPath: yamlPath });
        }
      }
    } catch { /* ignore */ }
  }

  return entries;
}

function parseConfig(configPath: string): ProjectConfig | null {
  try {
    const raw = readFileSync(configPath, 'utf-8');
    const lines = raw.split('\n');

    let project = '';
    let workspace: string | undefined;
    const repos: RepoEntry[] = [];

    let currentRepo: Partial<RepoEntry> | null = null;
    let inCommands = false;

    const flushRepo = () => {
      if (currentRepo && currentRepo.name) {
        repos.push({
          name: currentRepo.name,
          path: currentRepo.path || `./${currentRepo.name}`,
          github: currentRepo.github,
          installCmd: currentRepo.installCmd,
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
        flushRepo();
        inRepos = false;

        const scalar = stripped.match(/^(\w[\w_-]*):\s+(.+)$/);
        if (scalar) {
          const val = scalar[2].replace(/^["']|["']$/g, '').trim();
          if (scalar[1] === 'project' || scalar[1] === 'project') project = val;
          else if (scalar[1] === 'workspace') workspace = val.replace(/^~/, homedir());
        }

        if (/^repos:\s*$/.test(stripped)) inRepos = true;
        continue;
      }

      if (inRepos) {
        const repoStart = stripped.match(/^\s{2,4}-\s+name:\s+(.+)/);
        if (repoStart) {
          flushRepo();
          currentRepo = { name: repoStart[1].trim() };
          inCommands = false;
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
            if (inCommands && kv[1] === 'install') {
              currentRepo.installCmd = val;
            } else if (!inCommands) {
              if (kv[1] === 'path') currentRepo.path = val;
              else if (kv[1] === 'github') currentRepo.github = val;
            }
          }
        }
      }
    }

    flushRepo();
    return { project: project || 'unknown', workspace, repos };
  } catch {
    return null;
  }
}

function resolveWorkspace(config: ProjectConfig, projectName: string): string {
  if (config.workspace) {
    return config.workspace.startsWith('/') ? config.workspace : join(homedir(), config.workspace);
  }
  const wsRoot = process.env.ANVIL_WORKSPACE_ROOT || process.env.FF_WORKSPACE_ROOT || join(homedir(), 'workspace');
  return join(wsRoot, projectName);
}

function resolveRepoPath(wsPath: string, repoPath: string): string {
  if (repoPath.startsWith('/')) return repoPath;
  return join(wsPath, repoPath.replace(/^\.\//, ''));
}

async function promptSelection(projects: Array<{ name: string }>): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  console.log('');
  console.log(pc.bold('Available projects:'));
  projects.forEach((p, i) => {
    console.log(`  ${i + 1}. ${p.name}`);
  });
  console.log('');

  return new Promise((resolve, reject) => {
    rl.question('Select a project (number or name): ', (answer) => {
      rl.close();
      const num = parseInt(answer, 10);
      if (num >= 1 && num <= projects.length) {
        resolve(projects[num - 1].name);
      } else {
        const match = projects.find((p) => p.name === answer.trim());
        if (match) resolve(match.name);
        else reject(new Error(`Unknown project: ${answer}`));
      }
    });
  });
}

async function setupProject(projectName: string): Promise<void> {
  const configs = findProjectConfigs();
  const match = configs.find((c) => c.name === projectName);

  if (!match) {
    console.error(pc.red(`Project "${projectName}" not found.`));
    console.error(`Available: ${configs.map((c) => c.name).join(', ') || '(none)'}`);
    process.exitCode = 1;
    return;
  }

  const config = parseConfig(match.configPath);
  if (!config) {
    console.error(pc.red(`Failed to parse config at ${match.configPath}`));
    process.exitCode = 1;
    return;
  }

  const wsPath = resolveWorkspace(config, projectName);
  console.log('');
  console.log(pc.bold(`Setting up project: ${projectName}`));
  console.log(pc.dim(`Workspace: ${wsPath}`));
  console.log('');

  if (!existsSync(wsPath)) {
    mkdirSync(wsPath, { recursive: true });
    console.log(`  Created workspace directory: ${wsPath}`);
  }

  let cloned = 0;
  let updated = 0;
  let installed = 0;
  const total = config.repos.length;

  for (const repo of config.repos) {
    const repoPath = resolveRepoPath(wsPath, repo.path);

    if (!existsSync(repoPath)) {
      if (repo.github) {
        const url = `https://github.com/${repo.github}.git`;
        console.log(`  ${pc.yellow('cloning')} ${repo.name} from ${repo.github}...`);
        try {
          execFileSync('git', ['clone', url, repoPath], {
            encoding: 'utf-8',
            timeout: 120_000,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          cloned++;
          console.log(`  ${pc.green('\u2713')} ${repo.name} cloned`);
        } catch (err: any) {
          console.error(`  ${pc.red('\u2717')} ${repo.name} — clone failed: ${(err.message || '').slice(0, 100)}`);
          continue;
        }
      } else {
        console.log(`  ${pc.yellow('\u25CB')} ${repo.name} — no github field, skipping clone`);
        continue;
      }
    } else {
      console.log(`  ${pc.blue('pulling')} ${repo.name}...`);
      try {
        execFileSync('git', ['pull'], {
          cwd: repoPath,
          encoding: 'utf-8',
          timeout: 30_000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        updated++;
        console.log(`  ${pc.green('\u2713')} ${repo.name} updated`);
      } catch {
        console.log(`  ${pc.yellow('\u25CB')} ${repo.name} — pull failed (may have uncommitted changes)`);
      }
    }

    // Run install command if configured
    if (repo.installCmd && existsSync(repoPath)) {
      console.log(`  ${pc.blue('installing')} ${repo.name} deps (${repo.installCmd})...`);
      try {
        const [installBin, ...installArgs] = repo.installCmd.split(/\s+/);
        execFileSync(installBin, installArgs, {
          cwd: repoPath,
          encoding: 'utf-8',
          timeout: 300_000,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        installed++;
        console.log(`  ${pc.green('\u2713')} ${repo.name} dependencies installed`);
      } catch (err: any) {
        console.error(`  ${pc.red('\u2717')} ${repo.name} — install failed: ${(err.message || '').slice(0, 100)}`);
      }
    }
  }

  console.log('');
  console.log(pc.bold(`Set up ${cloned + updated}/${total} repos for ${projectName}`));
  if (cloned > 0) console.log(`  ${cloned} cloned`);
  if (updated > 0) console.log(`  ${updated} updated`);
  if (installed > 0) console.log(`  ${installed} dependencies installed`);
  console.log('');
}

export const setupCommand = new Command('setup')
  .description('Clone and set up project repositories')
  .argument('[project]', 'Project name to set up')
  .action(async (projectArg?: string) => {
    if (projectArg) {
      await setupProject(projectArg);
      return;
    }

    // No project arg — prompt user
    const configs = findProjectConfigs();
    if (configs.length === 0) {
      console.error(pc.red('No projects configured. Run anvil init first.'));
      process.exitCode = 1;
      return;
    }

    try {
      const selected = await promptSelection(configs);
      await setupProject(selected);
    } catch (err: any) {
      console.error(pc.red(err.message));
      process.exitCode = 1;
    }
  });
