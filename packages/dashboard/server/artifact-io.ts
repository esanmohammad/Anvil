/**
 * `artifact-io` — load + write helpers for per-stage and per-repo
 * artifacts under `~/.anvil/features/<project>/<slug>/`.
 *
 * Extracted from `pipeline-runner.ts`. Each function takes an
 * `ArtifactIODeps` opts bag; no module-level state.
 */
import type { FeatureStore } from './feature-store.js';
import type {
  PipelineConfig,
  PipelineRunState,
  StageDefinition,
} from './pipeline-runner-types.js';

export interface ArtifactIODeps {
  config: PipelineConfig;
  state: PipelineRunState;
  featureStore: FeatureStore;
  emit: (event: 'artifact-written', payload: {
    stage: string;
    file: string;
    repo?: string;
    summary: string;
    content: string;
  }) => void;
}

/** Load all prior stage artifacts to build context for resume. */
export function loadPriorArtifacts(deps: ArtifactIODeps): string {
  const project = deps.config.project;
  const slug = deps.state.featureSlug;
  const parts: string[] = [];

  const mainArtifacts = ['CLARIFICATION.md', 'REQUIREMENTS.md'];
  for (const file of mainArtifacts) {
    const content = deps.featureStore.readArtifact(project, slug, file);
    if (content) parts.push(`## ${file}\n${content}`);
  }

  for (const repoName of deps.state.repoNames) {
    const repoArtifacts = ['REQUIREMENTS.md', 'SPECS.md', 'TASKS.md', 'BUILD.md', 'VALIDATE.md'];
    for (const file of repoArtifacts) {
      const content = deps.featureStore.readArtifact(project, slug, `repos/${repoName}/${file}`);
      if (content) parts.push(`## ${repoName}/${file}\n${content}`);
    }
  }

  if (deps.config.failureContext) {
    parts.push(`## Previous Failure\n${deps.config.failureContext}`);
  }

  return parts.join('\n\n---\n\n');
}

/** Load a single stage's artifact from the feature store. */
export function loadStageArtifact(deps: ArtifactIODeps, stage: StageDefinition): string {
  const project = deps.config.project;
  const slug = deps.state.featureSlug;

  const mainArtifactMap: Record<string, string> = {
    clarify: 'CLARIFICATION.md',
    requirements: 'REQUIREMENTS.md',
    ship: 'SHIP.md',
  };

  const repoArtifactMap: Record<string, string> = {
    'repo-requirements': 'REQUIREMENTS.md',
    specs: 'SPECS.md',
    tasks: 'TASKS.md',
    build: 'BUILD.md',
    validate: 'VALIDATE.md',
  };

  const mainFile = mainArtifactMap[stage.name];
  if (mainFile) {
    return deps.featureStore.readArtifact(project, slug, mainFile) ?? '';
  }

  const repoFile = repoArtifactMap[stage.name];
  if (repoFile && deps.state.repoNames.length > 0) {
    const parts: string[] = [];
    for (const repoName of deps.state.repoNames) {
      const content = deps.featureStore.readArtifact(project, slug, `repos/${repoName}/${repoFile}`);
      if (content) parts.push(`## ${repoName}\n${content}`);
    }
    return parts.join('\n\n');
  }

  return '';
}

/** Load per-repo artifacts the next stage's prompt-builder needs. */
export function loadRepoArtifacts(
  deps: ArtifactIODeps,
  repoName: string,
): { requirements: string; specs: string; tasks: string; build: string } {
  const project = deps.config.project;
  const slug = deps.state.featureSlug;
  return {
    requirements: deps.featureStore.readArtifact(project, slug, `repos/${repoName}/REQUIREMENTS.md`) ?? '',
    specs: deps.featureStore.readArtifact(project, slug, `repos/${repoName}/SPECS.md`) ?? '',
    tasks: deps.featureStore.readArtifact(project, slug, `repos/${repoName}/TASKS.md`) ?? '',
    build: deps.featureStore.readArtifact(project, slug, `repos/${repoName}/BUILD.md`) ?? '',
  };
}

/** Load the high-level (cross-repo) requirements artifact. */
export function loadHighLevelRequirements(deps: ArtifactIODeps): string {
  return deps.featureStore.readArtifact(deps.config.project, deps.state.featureSlug, 'REQUIREMENTS.md') ?? '';
}

/** Persist a single-stage artifact (clarify/requirements/ship). */
export function writeStageArtifact(
  deps: ArtifactIODeps,
  stage: StageDefinition,
  artifact: string,
): void {
  try {
    const artifactMap: Record<string, string> = {
      clarify: 'CLARIFICATION.md',
      requirements: 'REQUIREMENTS.md',
      ship: 'SHIP.md',
    };

    const filename = artifactMap[stage.name];
    if (filename) {
      const featureDir = deps.featureStore.getFeatureDir(deps.config.project, deps.state.featureSlug);
      deps.featureStore.writeArtifact(deps.config.project, deps.state.featureSlug, filename, artifact);
      deps.emit('artifact-written', {
        stage: stage.name,
        file: `${featureDir}/${filename}`,
        summary: `${stage.label} artifact`,
        content: artifact,
      });
    }
  } catch (err) {
    console.warn(`[pipeline] Failed to write artifact for ${stage.name}:`, err);
  }
}

/** Persist a per-repo artifact under `repos/<repoName>/`. */
export function writeRepoArtifact(
  deps: ArtifactIODeps,
  stage: StageDefinition,
  repoName: string,
  artifact: string,
): void {
  try {
    const artifactMap: Record<string, string> = {
      'repo-requirements': 'REQUIREMENTS.md',
      specs: 'SPECS.md',
      tasks: 'TASKS.md',
      build: 'BUILD.md',
      validate: 'VALIDATE.md',
    };

    const filename = artifactMap[stage.name];
    if (filename) {
      const relativePath = `repos/${repoName}/${filename}`;
      const featureDir = deps.featureStore.getFeatureDir(deps.config.project, deps.state.featureSlug);
      deps.featureStore.writeArtifact(deps.config.project, deps.state.featureSlug, relativePath, artifact);
      deps.emit('artifact-written', {
        stage: stage.name,
        file: `${featureDir}/${relativePath}`,
        repo: repoName,
        summary: `${stage.label} for ${repoName}`,
        content: artifact,
      });
    }
  } catch (err) {
    console.warn(`[pipeline] Failed to write repo artifact for ${stage.name}/${repoName}:`, err);
  }
}
