/**
 * Feature-store helper — Phase 5 of core-pipeline consolidation.
 *
 * Lifted from `orchestrator.ts:903-953` (resume artifact loader) +
 * `orchestrator.ts:287-313` (loadPipelineDeployCmd). Loads prior-run
 * artifacts from `~/.anvil/features/<project>/<slug>/` so the new
 * runner can populate `ctx.shared.priorArtifacts` when resuming.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface PriorArtifacts {
  clarification?: string;
  highLevelRequirements?: string;
  /** Per-repo requirements artifact (from the `repo-requirements` stage), keyed by repo name. */
  repoRequirements: Map<string, string>;
  /** Per-repo specs artifact, keyed by repo name. */
  projectSpecs: Map<string, string>;
  /** Per-repo tasks artifact, keyed by repo name. */
  projectTasks: Map<string, string>;
}

function anvilHome(): string {
  return process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil');
}

/**
 * Load prior-run artifacts for a given (project, featureSlug) pair from
 * the feature store. Returns an empty record when nothing is on disk.
 */
export function loadPriorArtifacts(
  project: string,
  featureSlug: string,
  repoNames: string[],
): PriorArtifacts {
  const featureDir = join(anvilHome(), 'features', project, featureSlug);

  const result: PriorArtifacts = {
    repoRequirements: new Map(),
    projectSpecs: new Map(),
    projectTasks: new Map(),
  };

  const readArtifact = (relativePath: string): string | undefined => {
    const fullPath = join(featureDir, relativePath);
    try {
      return readFileSync(fullPath, 'utf-8');
    } catch {
      return undefined;
    }
  };

  result.clarification = readArtifact('CLARIFICATION.md');
  result.highLevelRequirements = readArtifact('REQUIREMENTS.md');

  for (const repoName of repoNames) {
    const reqs = readArtifact(`repos/${repoName}/REQUIREMENTS.md`);
    if (reqs) result.repoRequirements.set(repoName, reqs);
    const specs = readArtifact(`repos/${repoName}/SPECS.md`);
    if (specs) result.projectSpecs.set(repoName, specs);
    const tasks = readArtifact(`repos/${repoName}/TASKS.md`);
    if (tasks) result.projectTasks.set(repoName, tasks);
  }

  return result;
}

/**
 * Read pipeline.ship.deploy from factory.yaml. Returns the deploy
 * command string, or null if not configured.
 */
export function loadPipelineDeployCmd(project: string): string | null {
  const paths = [
    join(anvilHome(), 'projects', project, 'factory.yaml'),
    join(anvilHome(), 'projects', project, 'project.yaml'),
  ];

  for (const configPath of paths) {
    if (!existsSync(configPath)) continue;
    try {
      const raw = readFileSync(configPath, 'utf-8');
      const deployMatch = raw.match(/^\s{4}deploy:\s+(.+)$/m);
      if (deployMatch && deployMatch.index !== undefined) {
        const pipelineIdx = raw.search(/^pipeline:\s*$/m);
        const shipIdx = raw.search(/^\s{2}ship:\s*$/m);
        if (pipelineIdx !== -1 && shipIdx !== -1 && shipIdx > pipelineIdx && deployMatch.index > shipIdx) {
          return deployMatch[1].replace(/^["']|["']$/g, '').trim();
        }
      }
    } catch {
      /* best-effort */
    }
  }
  return null;
}

/** Map of artifact IDs → relative paths in the feature dir. */
export const FEATURE_STORE_ARTIFACT_PATHS: Record<string, string> = {
  'CLARIFICATION.md': 'CLARIFICATION.md',
  'HIGH-LEVEL-REQUIREMENTS.md': 'REQUIREMENTS.md',
  'REQUIREMENTS.md': 'REQUIREMENTS.md',
  'VALIDATION.md': 'VALIDATION.md',
};
