/**
 * `pipeline-bootstrap` — workspace + repo discovery helpers extracted
 * from `pipeline-runner.ts`.
 *
 * Each function takes a `BootstrapDeps` opts bag; no module-level state.
 * Mutations to caller-supplied state (`state.repoNames`, per-stage
 * `repos[]` slots) happen through the deps bag's setters.
 */
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectInfo, ProjectLoader } from './project-loader.js';
import { pullBaseBranchForRepos } from './steps/workspace-ops.js';
import type {
  PipelineConfig,
  PipelineRunState,
} from './pipeline-runner-types.js';

export interface BootstrapDeps {
  config: PipelineConfig;
  projectLoader: ProjectLoader;
  state: PipelineRunState;
  workspaceDir: string;
  emitProjectEvent: (payload: {
    source: string;
    message: string;
    level?: 'info' | 'warn';
  }) => void;
  setProjectInfo: (info: ProjectInfo | null) => void;
  setRepoPaths: (paths: Record<string, string>) => void;
  /** Mutate-in-place getter for repoPaths during repo detection. */
  getRepoPaths: () => Record<string, string>;
  broadcast: () => void;
  checkpoint: () => void;
}

/** Resolve the base branch (config override → "main"). */
export function getBaseBranch(config: PipelineConfig): string {
  return config.baseBranch || 'main';
}

/**
 * Checkout and pull the latest base branch for each repo before starting
 * the pipeline. Uses `config.baseBranch`, then falls through to main, then
 * master.
 */
export async function pullLatestMain(deps: BootstrapDeps): Promise<void> {
  await pullBaseBranchForRepos({
    baseBranch: deps.config.baseBranch,
    repoPaths: deps.getRepoPaths(),
    repoNames: deps.state.repoNames,
    workspaceDir: deps.workspaceDir,
    onLog: (level, message) => {
      if (level === 'info') console.log(`[pipeline] ${message}`);
      else console.warn(`[pipeline] ${message}`);
    },
  });
}

/**
 * Workspace + project bootstrap: load project info, ensure workspace
 * exists, resolve repo paths, hydrate per-repo state, pull the base
 * branch. Side effects flow through `deps`.
 */
export async function setupWorkspace(deps: BootstrapDeps): Promise<void> {
  console.log(`[pipeline] Setting up workspace for ${deps.config.project}...`);

  let projectInfo: ProjectInfo | null = null;
  try {
    projectInfo = await deps.projectLoader.getProject(deps.config.project);
    deps.setProjectInfo(projectInfo);
    deps.emitProjectEvent({
      source: 'project-context',
      message: `Project config loaded: "${deps.config.project}" (${projectInfo!.repos.length} repos)`,
    });
  } catch {
    console.warn(`[pipeline] Could not load project config for ${deps.config.project}`);
    deps.emitProjectEvent({
      source: 'project-context',
      message: `Could not load project config for "${deps.config.project}" — falling back to workspace scan`,
      level: 'warn',
    });
  }

  const wsStatus = await deps.projectLoader.ensureWorkspace(deps.config.project);
  if (!wsStatus.exists) {
    console.warn(`[pipeline] Workspace not ready: ${wsStatus.path}`);
  } else {
    deps.emitProjectEvent({
      source: 'project-context',
      message: `Workspace ready at ${wsStatus.path}`,
    });
  }

  const repoPaths = deps.projectLoader.getRepoLocalPaths(deps.config.project);
  deps.setRepoPaths(repoPaths);
  const repoNames = Object.keys(repoPaths);

  if (deps.config.repos && deps.config.repos.length > 0) {
    deps.state.repoNames = deps.config.repos.filter((r) => repoNames.includes(r));
  } else if (repoNames.length > 0) {
    deps.state.repoNames = repoNames;
  }

  for (const stage of deps.state.stages) {
    if (stage.perRepo) {
      stage.repos = deps.state.repoNames.map((name) => ({
        repoName: name,
        agentId: null,
        status: 'pending',
        cost: 0,
        artifact: '',
        error: null,
      }));
    }
  }

  await pullLatestMain(deps);

  deps.broadcast();
  deps.checkpoint();
  console.log(`[pipeline] Workspace ready. Repos: ${deps.state.repoNames.join(', ') || '(none — will use project root)'}`);
}

/**
 * Workspace-scan fallback: when no repos came from project info, scan
 * `workspaceDir` for top-level git repos. Mutates `state.repoNames` +
 * the caller's `repoPaths` map (live ref) + per-stage `repos[]`.
 */
export function detectRepos(deps: BootstrapDeps): void {
  if (deps.state.repoNames.length > 0) return;

  try {
    const entries = readdirSync(deps.workspaceDir, { withFileTypes: true });
    const dirs = entries
      .filter((e) => {
        if (!e.isDirectory() || e.name.startsWith('.')) return false;
        const gitDir = join(deps.workspaceDir, e.name, '.git');
        return existsSync(gitDir);
      })
      .map((e) => e.name);
    if (dirs.length > 0) {
      deps.state.repoNames = dirs;
      const repoPaths = deps.getRepoPaths();
      for (const dir of dirs) {
        repoPaths[dir] = join(deps.workspaceDir, dir);
      }
      console.log(`[pipeline] Detected repos from workspace: ${dirs.join(', ')}`);
      for (const stage of deps.state.stages) {
        if (stage.perRepo) {
          stage.repos = dirs.map((name) => ({
            repoName: name,
            agentId: null,
            status: 'pending',
            cost: 0,
            artifact: '',
            error: null,
          }));
        }
      }
      deps.broadcast();
    }
  } catch {
    /* workspace might not exist */
  }
}
