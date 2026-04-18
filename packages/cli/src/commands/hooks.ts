import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import pc from 'picocolors';
import { info, success, error, warn } from '../logger.js';
import { getAnvilHome } from '../home.js';

// ── Hook script templates ────────────────────────────────────────────────

const HOOK_MARKER = '# Anvil';

const PRE_PUSH_HOOK = `#!/bin/sh
# Anvil pre-push hook — auto-review changes before pushing
echo "[anvil] Running pre-push review..."
anvil diff --against origin/main --severity error
if [ $? -ne 0 ]; then
  echo "[anvil] Review found errors. Push blocked."
  echo "[anvil] Run 'anvil diff' to see details, or push with --no-verify to skip."
  exit 1
fi
`;

const POST_MERGE_HOOK = `#!/bin/sh
# Anvil post-merge hook — keep knowledge base fresh
echo "[anvil] Updating knowledge index..."
anvil index --incremental 2>/dev/null || true
`;

const HOOK_SCRIPTS: Record<string, string> = {
  'pre-push': PRE_PUSH_HOOK,
  'post-merge': POST_MERGE_HOOK,
};

// ── Minimal config parsing (mirrors setup.ts) ───────────────────────────

interface RepoEntry {
  name: string;
  path: string;
}

interface ProjectConfig {
  project: string;
  workspace?: string;
  repos: RepoEntry[];
}

function findProjectConfigs(): Array<{ name: string; configPath: string }> {
  const home = getAnvilHome();
  const entries: Array<{ name: string; configPath: string }> = [];

  for (const dir of ['projects', 'projects']) {
    const base = join(home, dir);
    if (!existsSync(base)) continue;
    try {
      for (const name of readdirSync(base)) {
        if (name.startsWith('.')) continue;
        if (entries.some((e) => e.name === name)) continue;
        const yamlName = dir === 'projects' ? 'factory.yaml' : 'project.yaml';
        const yamlPath = join(base, name, yamlName);
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
    let inRepos = false;

    const flushRepo = () => {
      if (currentRepo && currentRepo.name) {
        repos.push({
          name: currentRepo.name,
          path: currentRepo.path || `./${currentRepo.name}`,
        });
      }
      currentRepo = null;
    };

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
          continue;
        }

        if (currentRepo) {
          const pathMatch = stripped.match(/^\s{4,8}path:\s+(.+)/);
          if (pathMatch) {
            currentRepo.path = pathMatch[1].replace(/^["']|["']$/g, '').trim().replace(/^~/, homedir());
          }
        }
      }
    }

    flushRepo();
    if (!project) return null;
    return { project, workspace, repos };
  } catch {
    return null;
  }
}

function resolveRepoPaths(config: ProjectConfig): string[] {
  const base = config.workspace || join(homedir(), 'workspace');
  return config.repos.map((r) => {
    const p = r.path;
    if (p.startsWith('/')) return p;
    return join(base, p.replace(/^\.\//, ''));
  });
}

function getProjectRepos(project?: string): Array<{ project: string; repoPath: string }> {
  const configs = findProjectConfigs();
  const filtered = project ? configs.filter((c) => c.name === project) : configs;

  if (filtered.length === 0) {
    if (project) {
      error(`Project "${project}" not found.`);
    } else {
      error('No project configurations found.');
    }
    return [];
  }

  const results: Array<{ project: string; repoPath: string }> = [];
  for (const entry of filtered) {
    const config = parseConfig(entry.configPath);
    if (!config) continue;
    for (const repoPath of resolveRepoPaths(config)) {
      results.push({ project: entry.name, repoPath });
    }
  }

  return results;
}

function isAnvilHook(hookPath: string): boolean {
  if (!existsSync(hookPath)) return false;
  const content = readFileSync(hookPath, 'utf-8');
  return content.includes(HOOK_MARKER);
}

// ── Commands ─────────────────────────────────────────────────────────────

export const hooksCommand = new Command('hooks')
  .description('Manage git hooks for Anvil integration');

hooksCommand.addCommand(
  new Command('install')
    .description('Install Anvil git hooks in project repos')
    .argument('[project]', 'Project name')
    .option('--pre-push', 'Install pre-push hook (auto-review)')
    .option('--post-merge', 'Install post-merge hook (auto-index)')
    .option('--all', 'Install all hooks')
    .action(async (project: string | undefined, opts: { prePush?: boolean; postMerge?: boolean; all?: boolean }) => {
      const hooksToInstall: string[] = [];
      if (opts.all || (!opts.prePush && !opts.postMerge)) {
        hooksToInstall.push('pre-push', 'post-merge');
      } else {
        if (opts.prePush) hooksToInstall.push('pre-push');
        if (opts.postMerge) hooksToInstall.push('post-merge');
      }

      const repos = getProjectRepos(project);
      if (repos.length === 0) return;

      let installed = 0;
      let skipped = 0;

      for (const { project, repoPath } of repos) {
        const gitDir = join(repoPath, '.git');
        if (!existsSync(gitDir)) {
          warn(`${pc.bold(project)}: ${repoPath} is not a git repo — skipping.`);
          skipped++;
          continue;
        }

        const hooksDir = join(gitDir, 'hooks');
        if (!existsSync(hooksDir)) {
          mkdirSync(hooksDir, { recursive: true });
        }

        for (const hookName of hooksToInstall) {
          const hookPath = join(hooksDir, hookName);

          // Check for existing non-Anvil hook
          if (existsSync(hookPath) && !isAnvilHook(hookPath)) {
            warn(`${pc.bold(project)}: ${hookName} hook already exists in ${repoPath} (not an Anvil hook) — skipping. Remove it manually to install.`);
            skipped++;
            continue;
          }

          writeFileSync(hookPath, HOOK_SCRIPTS[hookName], 'utf-8');
          chmodSync(hookPath, 0o755);
          installed++;
          success(`${pc.bold(project)}: installed ${pc.cyan(hookName)} hook in ${repoPath}`);
        }
      }

      console.log();
      info(`Done. ${pc.bold(String(installed))} hook(s) installed, ${pc.bold(String(skipped))} skipped.`);
    }),
);

hooksCommand.addCommand(
  new Command('uninstall')
    .description('Remove Anvil git hooks')
    .argument('[project]', 'Project name')
    .action(async (project: string | undefined) => {
      const repos = getProjectRepos(project);
      if (repos.length === 0) return;

      let removed = 0;

      for (const { project, repoPath } of repos) {
        const hooksDir = join(repoPath, '.git', 'hooks');
        if (!existsSync(hooksDir)) continue;

        for (const hookName of Object.keys(HOOK_SCRIPTS)) {
          const hookPath = join(hooksDir, hookName);
          if (isAnvilHook(hookPath)) {
            writeFileSync(hookPath, '', 'utf-8'); // clear the file
            // Actually remove the file
            const { unlinkSync } = await import('node:fs');
            unlinkSync(hookPath);
            removed++;
            success(`${pc.bold(project)}: removed ${pc.cyan(hookName)} hook from ${repoPath}`);
          }
        }
      }

      if (removed === 0) {
        info('No Anvil hooks found to remove.');
      } else {
        console.log();
        info(`Removed ${pc.bold(String(removed))} hook(s).`);
      }
    }),
);

hooksCommand.addCommand(
  new Command('status')
    .description('Show installed hooks status')
    .argument('[project]', 'Project name')
    .action(async (project: string | undefined) => {
      const repos = getProjectRepos(project);
      if (repos.length === 0) return;

      for (const { project, repoPath } of repos) {
        const hooksDir = join(repoPath, '.git', 'hooks');
        console.log(pc.bold(`\n${project}`) + ` ${pc.dim(repoPath)}`);

        if (!existsSync(hooksDir)) {
          console.log(`  ${pc.dim('No .git/hooks directory')}`);
          continue;
        }

        for (const hookName of Object.keys(HOOK_SCRIPTS)) {
          const hookPath = join(hooksDir, hookName);
          if (!existsSync(hookPath)) {
            console.log(`  ${pc.dim('-')} ${hookName}: ${pc.dim('not installed')}`);
          } else if (isAnvilHook(hookPath)) {
            console.log(`  ${pc.green('+')} ${hookName}: ${pc.green('installed')}`);
          } else {
            console.log(`  ${pc.yellow('~')} ${hookName}: ${pc.yellow('exists (non-Anvil)')}`);
          }
        }
      }

      console.log();
    }),
);
