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
/**
 * Minimal shell shim — synchronous execution that returns stdout (or
 * throws on non-zero exit). Tests can supply a fake to capture
 * commands without invoking anything.
 */
export interface ShellRunner {
    run: (cmd: string, opts: {
        cwd: string;
        timeout?: number;
    }) => string;
}
/**
 * Run a shell command and silently swallow failures — used by post-build
 * guards (formatters/linters that may not be installed) and similar
 * best-effort cleanup. Mirrors `pipeline-runner.runSilent()`.
 */
export declare function runSilent(cmd: string, cwd: string, runner?: ShellRunner): void;
/**
 * Resolve `dir/filename` against the filesystem. Mirrors
 * `pipeline-runner.fileExists()`.
 */
export declare function fileExists(dir: string, filename: string): boolean;
export interface PullBaseBranchOptions {
    /** Base branch to pull. When omitted, the helper auto-detects main → master. */
    baseBranch?: string;
    /** Map of repoName → absolute path. */
    repoPaths: Record<string, string>;
    /** Repo names to pull, in order. Empty → fall back to workspaceDir. */
    repoNames: string[];
    /** Used as the cwd when `repoNames` is empty. */
    workspaceDir: string;
    /** Optional log callback (legacy: console.log + console.warn). */
    onLog?: (level: 'info' | 'warn', message: string) => void;
    /** Test seam — defaults to a real `execSync` wrapper. */
    runner?: ShellRunner;
}
/**
 * Checkout + pull the base branch for each repo (or workspace root when
 * no repos). Mirrors `pipeline-runner.pullLatestMain()` step-by-step:
 *   - Explicit `baseBranch` → pull that single branch (no fallback).
 *   - Auto-detect → try `main`, fall back to `master`.
 *   - Repo dirs that don't exist on disk are skipped.
 */
export declare function pullBaseBranchForRepos(opts: PullBaseBranchOptions): Promise<void>;
export interface RepoCommands {
    format?: string;
    lint?: string;
}
export interface RunPostBuildGuardsOptions {
    /** Per-repo (name + path) — empty list triggers single-repo mode. */
    repos: Array<{
        name: string;
        path: string;
    }>;
    /**
     * Optional resolver for project-config-based commands (factory.yaml).
     * Returns null/undefined when no config exists for the repo.
     */
    getRepoCommands?: (repoName: string) => RepoCommands | null | undefined;
    /** Optional log callback — legacy uses `console.log` + `console.warn`. */
    onLog?: (level: 'info' | 'warn', message: string) => void;
    runner?: ShellRunner;
}
/**
 * Run formatters + linters with auto-fix per repo. Mirrors
 * `pipeline-runner.runPostBuildGuards()`:
 *   - factory.yaml `format` / `lint` commands take precedence.
 *   - Otherwise: language detection (Go / TS / Python) → standard tools.
 *   - All commands are best-effort (`runSilent`); failures don't abort.
 */
export declare function runPostBuildGuards(opts: RunPostBuildGuardsOptions): void;
export interface DeployArtifact {
    stage: 'ship';
    file: 'SANDBOX_URL' | 'LOCAL_URL';
    summary: string;
    content: string;
}
export interface DeployProjectOptions {
    project: string;
    /** Resolved deploy mode — `false` (or undefined) skips deployment. */
    mode: 'local' | 'remote' | false | undefined;
    workspaceDir: string;
    /** factory.yaml's `pipeline.ship.deploy` if any. */
    configDeployCmd?: string;
    /** Env-var fallback (legacy: ANVIL_DEPLOY_CMD || FF_DEPLOY_CMD). */
    envDeployCmd?: string;
    /** Called with the parsed sandbox URL (legacy: emit('artifact-written')). */
    onArtifact?: (artifact: DeployArtifact) => void;
    /** Optional log callback. */
    onLog?: (level: 'info' | 'warn', message: string) => void;
    runner?: ShellRunner;
}
/**
 * Deploy the project to a sandbox. Mirrors `pipeline-runner.deployToRemote()`:
 *   - `mode === undefined | false` → skip.
 *   - factory.yaml command > env-var fallback > skip.
 *   - 10-minute timeout, non-blocking on failure.
 *   - URL extracted via `https?://\S+` regex; emitted as an artifact.
 */
export declare function deployProject(opts: DeployProjectOptions): void;
export interface CreateFeatureBranchesOptions {
    /** Slug used in the branch name (`anvil/<featureSlug>`). */
    featureSlug: string;
    repoPaths: Record<string, string>;
    repoNames: string[];
    /** Used when `repoNames` is empty (single-repo / mono-repo project). */
    workspaceDir: string;
    onLog?: (level: 'info' | 'warn', message: string) => void;
    runner?: ShellRunner;
}
/**
 * Create (or check out, if already present) the `anvil/<featureSlug>`
 * branch in each repo. Mirrors `pipeline-runner.createFeatureBranches()`:
 *   - `git rev-parse --verify` checks for existing branch.
 *   - If exists → `git checkout`. Else → `git checkout -b`.
 *   - Failures per repo are warned but don't abort the whole call.
 *   - Empty `repoNames` falls back to creating the branch in `workspaceDir`.
 */
export declare function createFeatureBranches(opts: CreateFeatureBranchesOptions): void;
//# sourceMappingURL=workspace-ops.d.ts.map