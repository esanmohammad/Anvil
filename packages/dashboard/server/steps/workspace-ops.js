/**
 * `workspace-ops` — Phase 4f.6 of the dashboard consolidation.
 *
 * Lifts the deterministic git / shell-side helpers that
 * `pipeline-runner.ts` calls between LLM-agent stages:
 *
 *   - `pullBaseBranchForRepos`  ← `pipeline-runner.pullLatestMain()`
 *   - `runPostBuildGuards`      ← `pipeline-runner.runPostBuildGuards()`
 *   - `deployProject`           ← `pipeline-runner.deployToRemote()`
 *   - `createFeatureBranches`   ← `pipeline-runner.createFeatureBranches()`
 *
 * Plus the two leaf helpers `runSilent` + `fileExists`. None of these
 * touch dashboard state — pipeline-runner keeps the `setupWorkspace`
 * orchestration that mutates `state.stages[].repos`, `repoPaths`, and
 * `broadcastState`/`checkpoint`. All the helpers below take an explicit
 * `runner` (defaults to a real `execSync` wrapper) so tests can swap in
 * a fake without spinning up real git repos or invoking shell tools.
 */
import { execSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
const defaultRunner = {
    run: (cmd, opts) => execSync(cmd, {
        cwd: opts.cwd,
        timeout: opts.timeout,
        stdio: 'pipe',
    }).toString(),
};
/**
 * Run a shell command and silently swallow failures — used by post-build
 * guards (formatters/linters that may not be installed) and similar
 * best-effort cleanup. Mirrors `pipeline-runner.runSilent()`.
 */
export function runSilent(cmd, cwd, runner = defaultRunner) {
    try {
        runner.run(cmd, { cwd, timeout: 60_000 });
    }
    catch {
        /* silently ignore — formatters/linters may not be installed */
    }
}
/**
 * Resolve `dir/filename` against the filesystem. Mirrors
 * `pipeline-runner.fileExists()`.
 */
export function fileExists(dir, filename) {
    try {
        return existsSync(join(dir, filename));
    }
    catch {
        return false;
    }
}
/**
 * Checkout + pull the base branch for each repo (or workspace root when
 * no repos). Mirrors `pipeline-runner.pullLatestMain()` step-by-step:
 *   - Explicit `baseBranch` → pull that single branch (no fallback).
 *   - Auto-detect → try `main`, fall back to `master`.
 *   - Repo dirs that don't exist on disk are skipped.
 */
export async function pullBaseBranchForRepos(opts) {
    const runner = opts.runner ?? defaultRunner;
    const pullBranch = (cwd, label) => {
        if (opts.baseBranch) {
            try {
                runner.run(`git fetch origin && git checkout "${opts.baseBranch}" && git pull origin "${opts.baseBranch}"`, { cwd, timeout: 30_000 });
                opts.onLog?.('info', `${label}: up to date with ${opts.baseBranch}`);
                return true;
            }
            catch {
                opts.onLog?.('warn', `${label}: could not pull ${opts.baseBranch} — continuing with current state`);
                return false;
            }
        }
        try {
            runner.run('git fetch origin && git checkout main && git pull origin main', {
                cwd,
                timeout: 30_000,
            });
            opts.onLog?.('info', `${label}: up to date with main`);
            return true;
        }
        catch {
            try {
                runner.run('git fetch origin && git checkout master && git pull origin master', {
                    cwd,
                    timeout: 30_000,
                });
                opts.onLog?.('info', `${label}: up to date with master`);
                return true;
            }
            catch {
                opts.onLog?.('warn', `${label}: could not pull latest — continuing with current state`);
                return false;
            }
        }
    };
    if (opts.repoNames.length === 0) {
        pullBranch(opts.workspaceDir, 'workspace root');
        return;
    }
    for (const repoName of opts.repoNames) {
        const repoPath = opts.repoPaths[repoName];
        if (!repoPath || !existsSync(repoPath))
            continue;
        pullBranch(repoPath, repoName);
    }
}
/**
 * Run formatters + linters with auto-fix per repo. Mirrors
 * `pipeline-runner.runPostBuildGuards()`:
 *   - factory.yaml `format` / `lint` commands take precedence.
 *   - Otherwise: language detection (Go / TS / Python) → standard tools.
 *   - All commands are best-effort (`runSilent`); failures don't abort.
 */
export function runPostBuildGuards(opts) {
    const runner = opts.runner ?? defaultRunner;
    for (const repo of opts.repos) {
        try {
            const repoCommands = opts.getRepoCommands?.(repo.name);
            if (repoCommands?.format) {
                runSilent(repoCommands.format, repo.path, runner);
            }
            if (repoCommands?.lint) {
                runSilent(repoCommands.lint, repo.path, runner);
            }
            if (!repoCommands?.format && !repoCommands?.lint) {
                const hasGo = fileExists(repo.path, 'go.mod');
                const hasTs = fileExists(repo.path, 'tsconfig.json');
                const hasPackageJson = fileExists(repo.path, 'package.json');
                const hasPython = fileExists(repo.path, 'pyproject.toml') || fileExists(repo.path, 'setup.py');
                if (hasGo) {
                    runSilent('gofmt -w .', repo.path, runner);
                    runSilent('golangci-lint run --fix ./... 2>/dev/null', repo.path, runner);
                }
                if (hasTs || hasPackageJson) {
                    runSilent('npx prettier --write "**/*.{ts,tsx,js,jsx}" --ignore-unknown 2>/dev/null', repo.path, runner);
                    runSilent('npx eslint --fix "**/*.{ts,tsx,js,jsx}" 2>/dev/null', repo.path, runner);
                }
                if (hasPython) {
                    runSilent('black . 2>/dev/null', repo.path, runner);
                    runSilent('ruff check --fix . 2>/dev/null', repo.path, runner);
                }
            }
        }
        catch (err) {
            opts.onLog?.('warn', `Post-build guard error in ${repo.name}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
}
/**
 * Deploy the project to a sandbox. Mirrors `pipeline-runner.deployToRemote()`:
 *   - `mode === undefined | false` → skip.
 *   - factory.yaml command > env-var fallback > skip.
 *   - 10-minute timeout, non-blocking on failure.
 *   - URL extracted via `https?://\S+` regex; emitted as an artifact.
 */
export function deployProject(opts) {
    if (!opts.mode)
        return;
    const isRemote = opts.mode === 'remote';
    const label = isRemote ? 'remote sandbox' : 'local environment';
    let cmd;
    if (opts.configDeployCmd) {
        cmd = opts.configDeployCmd;
        opts.onLog?.('info', `Using deploy command from factory.yaml: ${cmd}`);
    }
    else if (opts.envDeployCmd) {
        cmd = isRemote
            ? `${opts.envDeployCmd} up ${opts.project} --remote`
            : `${opts.envDeployCmd} up ${opts.project}`;
        opts.onLog?.('info', `Using deploy command from ANVIL_DEPLOY_CMD: ${cmd}`);
    }
    else {
        opts.onLog?.('info', 'No deploy command configured — skipping sandbox deployment');
        return;
    }
    opts.onLog?.('info', `Deploying ${opts.project} to ${label}...`);
    const runner = opts.runner ?? defaultRunner;
    try {
        const result = runner.run(cmd, { cwd: opts.workspaceDir, timeout: 10 * 60 * 1000 });
        const urlMatch = result.match(/https?:\/\/\S+/);
        if (urlMatch) {
            opts.onLog?.('info', `Deployed: ${urlMatch[0]}`);
            opts.onArtifact?.({
                stage: 'ship',
                file: isRemote ? 'SANDBOX_URL' : 'LOCAL_URL',
                summary: `${label} deployed: ${urlMatch[0]}`,
                content: urlMatch[0],
            });
        }
        else {
            opts.onLog?.('info', `${label} deployed for ${opts.project}`);
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        opts.onLog?.('warn', `Deploy to ${label} failed (non-fatal): ${msg}`);
    }
}
/**
 * Create (or check out, if already present) the `anvil/<featureSlug>`
 * branch in each repo. Mirrors `pipeline-runner.createFeatureBranches()`:
 *   - `git rev-parse --verify` checks for existing branch.
 *   - If exists → `git checkout`. Else → `git checkout -b`.
 *   - Failures per repo are warned but don't abort the whole call.
 *   - Empty `repoNames` falls back to creating the branch in `workspaceDir`.
 */
export function createFeatureBranches(opts) {
    const branchName = `anvil/${opts.featureSlug}`;
    const runner = opts.runner ?? defaultRunner;
    const ensureBranch = (cwd, label) => {
        try {
            try {
                runner.run(`git rev-parse --verify "${branchName}"`, { cwd });
                runner.run(`git checkout "${branchName}"`, { cwd });
                opts.onLog?.('info', `Checked out existing branch "${branchName}" in ${label}`);
            }
            catch {
                runner.run(`git checkout -b "${branchName}"`, { cwd });
                opts.onLog?.('info', `Created branch "${branchName}" in ${label}`);
            }
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            opts.onLog?.('warn', `Failed to create branch in ${label}: ${msg}`);
        }
    };
    for (const repoName of opts.repoNames) {
        const repoPath = opts.repoPaths[repoName] ?? join(opts.workspaceDir, repoName);
        ensureBranch(repoPath, repoName);
    }
    if (opts.repoNames.length === 0) {
        ensureBranch(opts.workspaceDir, 'workspace root');
    }
}
//# sourceMappingURL=workspace-ops.js.map