/**
 * Post-build guards — Phase 5 of core-pipeline consolidation.
 *
 * Lifted from `orchestrator.ts:213-406`. Runs format + lint auto-fix
 * silently in each repo after build/fix iterations. Reads commands
 * from factory.yaml when available; falls back to language-based
 * auto-detection.
 *
 * Never fails the pipeline — guard failures are warnings only.
 */

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { info, warn } from '../logger.js';

function fileExistsIn(dir: string, filename: string): boolean {
  try {
    return existsSync(join(dir, filename));
  } catch {
    return false;
  }
}

function runSilent(cmd: string, cwd: string): { ok: boolean; error?: string } {
  try {
    execSync(cmd, { cwd, stdio: 'pipe', timeout: 60_000 });
    return { ok: true };
  } catch (err: unknown) {
    const e = err as { stderr?: { toString: () => string }; message?: string };
    const stderr = e?.stderr?.toString()?.slice(0, 200) || '';
    return { ok: false, error: stderr || e?.message?.slice(0, 200) || 'unknown error' };
  }
}

/** Minimal factory.yaml repo commands reader. Returns { format?, lint? }. */
function loadRepoCommandsFromConfig(project: string, repoName: string): { format?: string; lint?: string } | null {
  const anvilHome = process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil');
  const paths = [
    join(anvilHome, 'projects', project, 'factory.yaml'),
    join(anvilHome, 'projects', project, 'project.yaml'),
  ];

  for (const configPath of paths) {
    if (!existsSync(configPath)) continue;
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const repoPattern = new RegExp(
        `^\\s{2}-\\s+name:\\s+${repoName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`,
        'm',
      );
      const repoMatch = repoPattern.exec(raw);
      if (!repoMatch) continue;

      const afterRepo = raw.slice(repoMatch.index + repoMatch[0].length);
      const commandsMatch = afterRepo.match(/^\s{4,6}commands:\s*$/m);
      if (!commandsMatch || commandsMatch.index === undefined) continue;

      const afterCommands = afterRepo.slice(commandsMatch.index + commandsMatch[0].length);
      const commands: { format?: string; lint?: string } = {};

      for (const line of afterCommands.split('\n')) {
        if (/^\s{0,3}\S/.test(line) || /^\s{2}-\s+name:/.test(line)) break;
        if (/^\s{4,6}[a-z]/.test(line) && !/^\s{6,}/.test(line.replace(/^\s{4,6}\w/, ''))) {
          const kv = line.match(/^\s{6,8}(format|lint):\s+(.+)$/);
          if (kv) {
            const val = kv[2].replace(/^["']|["']$/g, '').trim();
            if (kv[1] === 'format') commands.format = val;
            if (kv[1] === 'lint') commands.lint = val;
          }
        }
      }

      if (commands.format || commands.lint) return commands;
    } catch {
      /* best-effort */
    }
  }
  return null;
}

/** Run formatters and linters with auto-fix in each repo after build. */
export function runPostBuildGuards(
  repoPaths: Record<string, string>,
  workspaceDir: string,
  repoNames: string[],
  project?: string,
): void {
  info('Running post-build guards (format + lint auto-fix)...');

  const repos = repoNames.length > 0
    ? repoNames.map((r) => ({ name: r, path: repoPaths[r] || join(workspaceDir, r) }))
    : [{ name: 'root', path: workspaceDir }];

  let passCount = 0;
  let failCount = 0;

  const runGuard = (cmd: string, repoName: string, repoPath: string): void => {
    const result = runSilent(cmd, repoPath);
    if (result.ok) {
      passCount++;
    } else {
      failCount++;
      warn(`Post-build guard failed in ${repoName}: ${cmd} — ${result.error}`);
    }
  };

  for (const repo of repos) {
    try {
      const repoCommands = project ? loadRepoCommandsFromConfig(project, repo.name) : null;
      if (repoCommands?.format) runGuard(repoCommands.format, repo.name, repo.path);
      if (repoCommands?.lint) runGuard(repoCommands.lint, repo.name, repo.path);

      if (!repoCommands?.format && !repoCommands?.lint) {
        const hasGo = fileExistsIn(repo.path, 'go.mod');
        const hasTs = fileExistsIn(repo.path, 'tsconfig.json');
        const hasPackageJson = fileExistsIn(repo.path, 'package.json');
        const hasPython = fileExistsIn(repo.path, 'pyproject.toml') || fileExistsIn(repo.path, 'setup.py');

        if (hasGo) {
          runGuard('gofmt -w .', repo.name, repo.path);
          runGuard('golangci-lint run --fix ./... 2>/dev/null', repo.name, repo.path);
        }
        if (hasTs || hasPackageJson) {
          runGuard('npx prettier --write "**/*.{ts,tsx,js,jsx}" --ignore-unknown 2>/dev/null', repo.name, repo.path);
          runGuard('npx eslint --fix "**/*.{ts,tsx,js,jsx}" 2>/dev/null', repo.name, repo.path);
        }
        if (hasPython) {
          runGuard('black . 2>/dev/null', repo.name, repo.path);
          runGuard('ruff check --fix . 2>/dev/null', repo.name, repo.path);
        }
      }
    } catch (err) {
      warn(`Post-build guard error in ${repo.name}: ${err}`);
    }
  }

  info(`Post-build guards: ${passCount} passed, ${failCount} failed${failCount > 0 ? ' (non-fatal)' : ''}`);
}

/** Detect VERDICT: FAIL or other failure markers in validate output. */
export function hasValidationFailures(artifact: string): boolean {
  if (!artifact) return false;
  return /VERDICT:\s*FAIL/i.test(artifact)
    || /UNRESOLVED/i.test(artifact)
    || /(?:build|lint|test).*(?:fail|error)/i.test(artifact);
}
