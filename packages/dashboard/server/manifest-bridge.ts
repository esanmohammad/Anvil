/**
 * `manifest-bridge` — pure helpers that read/write the feature manifest
 * on behalf of `PipelineRunner`. Extracted from `pipeline-runner.ts` so
 * the runner stays focused on orchestration.
 *
 * Every function takes a `ManifestBridgeDeps` opts bag and operates on
 * caller-supplied state. No FS state of its own; no module-level cache
 * (the per-run risk cache lives on a `PlanRiskCache` instance the
 * runner owns).
 */
import { execSync } from 'node:child_process';
import {
  computeRiskTier,
  scorePlan,
  renderRequirements,
  renderRepoRequirements,
  renderRepoSpecs,
  renderRepoTasks,
  extractAcceptanceCriteria,
  extractAffectedRepos,
  extractApiEndpoints,
  extractChangeBrief,
  extractFilesPlanned,
  extractOpenQuestions,
  extractTablesTouched,
  extractTestBehaviors,
  type ManifestExtractor,
  type Plan,
} from '@esankhan3/anvil-core-pipeline';
import {
  type FeatureManifestStore,
  type PlannedFile,
  type TestBehavior,
} from './feature-manifest.js';
import type { FeatureStore } from './feature-store.js';
import { STAGES } from './pipeline-runner-types.js';
import type {
  PipelineConfig,
  PipelineRunState,
  StageDefinition,
} from './pipeline-runner-types.js';

export interface ManifestBridgeDeps {
  project: string;
  feature: string;
  /** Read at call time so resume scenarios pick up the right slug. */
  featureSlug: () => string;
  manifestStore: FeatureManifestStore;
  featureStore: FeatureStore;
  state: PipelineRunState;
  config: PipelineConfig;
  /** Per-repo working-tree paths — read at call time (mutated post-bootstrap). */
  repoPaths: () => Record<string, string>;
  /** Drop the cached manifest render so the next prompt sees patched fields. */
  invalidateManifestCache: () => void;
  /** Broadcast state-change to WS subscribers. */
  broadcast: () => void;
  /** Persist run checkpoint to disk. */
  checkpoint: () => void;
}

/**
 * Per-run cache for plan risk tier + confidence. Computed once on first
 * read so every stage sees the same numbers; reset implicitly when a
 * fresh runner constructs a new instance.
 */
export class PlanRiskCache {
  private cached: { tier: 'low' | 'med' | 'high'; confidence: number } | null = null;

  get(planSeed: PipelineConfig['planSeed']): { tier?: 'low' | 'med' | 'high'; confidence?: number } {
    if (this.cached) return this.cached;
    if (!planSeed?.plan) return {};
    try {
      const score = scorePlan(planSeed.plan);
      const confidence = (planSeed.plan as unknown as { confidence?: number }).confidence;
      this.cached = {
        tier: computeRiskTier(score.overall),
        confidence: typeof confidence === 'number' ? confidence : 0.5,
      };
      return this.cached;
    } catch {
      return {};
    }
  }
}

/**
 * Best-effort list of files modified by this run so far, prefixed with the
 * repo name so policy globs like `backend/internal/db/**` can match across
 * a multi-repo workspace. Uses `git status --porcelain` per repo and
 * silently skips repos that error.
 */
export function manifestGetTouchedFiles(deps: ManifestBridgeDeps): string[] {
  const files: string[] = [];
  for (const [repoName, repoPath] of Object.entries(deps.repoPaths())) {
    if (!repoPath) continue;
    try {
      const out = execSync('git status --porcelain', {
        cwd: repoPath, encoding: 'utf-8', timeout: 10_000,
      });
      for (const line of out.split('\n')) {
        if (line.length < 4) continue;
        const path = (line.slice(3).trim().split(' -> ').pop() ?? '').trim();
        if (path) files.push(`${repoName}/${path}`);
      }
    } catch { /* per-repo best-effort */ }
  }
  return files;
}

/**
 * Pre-fill the manifest from a plan seed. Called before stage 5 (build)
 * runs so engineers see acceptance criteria, repo impact, planned files,
 * and test behaviors as `final` and don't re-derive them. Plans don't
 * always have explicit API/table sections, so those are left `unset`.
 */
export function populateManifestFromPlan(deps: ManifestBridgeDeps, plan: Plan): void {
  const project = deps.project;
  const slug = deps.featureSlug();
  deps.manifestStore.ensure(project, slug, deps.feature);

  const writer = 'plan-seed';

  if (plan.scope?.inScope?.length) {
    deps.manifestStore.patchField(
      project, slug, 'acceptanceCriteria', 'final',
      plan.scope.inScope.slice(),
      writer,
    );
  }

  const repoNames = (plan.repos ?? []).map((r) => r.name).filter((n): n is string => !!n);
  if (repoNames.length > 0) {
    deps.manifestStore.patchField(
      project, slug, 'affectedRepos', 'final',
      repoNames,
      writer,
    );
  }

  const filesPlanned: PlannedFile[] = [];
  for (const repo of plan.repos ?? []) {
    for (const file of repo.files ?? []) {
      filesPlanned.push({ repo: repo.name, path: file, kind: 'modify' });
    }
  }
  if (filesPlanned.length > 0) {
    deps.manifestStore.patchField(
      project, slug, 'filesPlanned', 'final',
      filesPlanned,
      writer,
    );
  }

  const testBehaviors: TestBehavior[] = [];
  for (const desc of plan.tests?.unit ?? []) testBehaviors.push({ description: desc });
  for (const desc of plan.tests?.integration ?? []) testBehaviors.push({ description: desc });
  for (const desc of plan.tests?.manual ?? []) testBehaviors.push({ description: desc });
  if (testBehaviors.length > 0) {
    deps.manifestStore.patchField(
      project, slug, 'testBehaviors', 'final',
      testBehaviors,
      writer,
    );
  }

  deps.invalidateManifestCache();
}

/**
 * Render plan-derived artifacts for stages that the walker skipped via
 * `skipIfByStage`. Mutates `state.stages[i]` and writes the artifact
 * through `featureStore`. Idempotent.
 */
export async function renderPlanDerivedArtifact(
  deps: ManifestBridgeDeps,
  stageName: string,
  stageIndex: number,
): Promise<void> {
  const seed = deps.config.planSeed;
  if (!seed) return;
  const { plan } = seed;
  const project = deps.config.project;
  const slug = deps.featureSlug();
  const i = stageIndex;
  if (i < 0 || !deps.state.stages[i]) return;

  if (stageName === 'requirements') {
    const artifact = renderRequirements(plan);
    deps.state.stages[i].status = 'skipped';
    deps.state.stages[i].artifact = artifact;
    try { deps.featureStore.writeArtifact(project, slug, 'REQUIREMENTS.md', artifact); } catch { /* non-fatal */ }
  } else {
    const filenameByStage: Record<string, string> = {
      'repo-requirements': 'REQUIREMENTS.md',
      specs: 'SPECS.md',
      tasks: 'TASKS.md',
    };
    const rendererByStage: Record<string, (p: typeof plan, r: string) => string> = {
      'repo-requirements': renderRepoRequirements,
      specs: renderRepoSpecs,
      tasks: renderRepoTasks,
    };
    const filename = filenameByStage[stageName];
    const renderer = rendererByStage[stageName];
    if (!filename || !renderer) return;

    const combined: string[] = [];
    deps.state.stages[i].repos = deps.state.repoNames.map((repoName) => {
      const artifact = renderer(plan, repoName);
      try {
        deps.featureStore.writeArtifact(project, slug, `repos/${repoName}/${filename}`, artifact);
      } catch { /* non-fatal */ }
      combined.push(`## ${repoName}\n${artifact}`);
      return {
        repoName,
        agentId: null,
        status: 'completed' as const,
        cost: 0,
        artifact,
        error: null,
      };
    });

    deps.state.stages[i].status = 'skipped';
    deps.state.stages[i].artifact = combined.join('\n\n');
  }

  deps.state.stages[i].completedAt = new Date().toISOString();
  deps.broadcast();
  deps.checkpoint();
}

/**
 * After a stage's artifact lands, extract structured fields and patch the
 * manifest. Uses heuristic deterministic parsers; safe to call for any
 * stage (no-ops when no extractor is registered).
 */
export async function extractAndUpdateManifest(
  deps: ManifestBridgeDeps,
  stage: StageDefinition,
  artifact: string,
): Promise<void> {
  const fieldsForStage: Partial<Record<string, ManifestExtractor[]>> = {
    requirements: [extractAcceptanceCriteria, extractAffectedRepos],
    specs: [extractApiEndpoints, extractTablesTouched, extractTestBehaviors],
    tasks: [extractFilesPlanned],
    build: [extractChangeBrief],
    validate: [extractOpenQuestions],
  };
  const extractors = fieldsForStage[stage.name];
  if (!extractors || extractors.length === 0) return;

  let mutated = false;
  for (const extractor of extractors) {
    try {
      const result = extractor(artifact);
      if (!result) continue;
      deps.manifestStore.patchField(
        deps.config.project, deps.featureSlug(),
        result.field, result.status, result.value as never,
        stage.name,
      );
      mutated = true;
    } catch (err) {
      console.warn(`[pipeline] manifest extractor ${stage.name} failed:`, err);
    }
  }
  if (mutated) deps.invalidateManifestCache();
}

/**
 * Wipe manifest fields written by stages [fromIndex .. toIndex] so the
 * "do not re-derive" prefix doesn't carry stale claims into the rerun.
 */
export function clearManifestFieldsForStages(
  deps: ManifestBridgeDeps,
  fromIndex: number,
  toIndex: number,
): void {
  const stageFields: Record<string, ReadonlyArray<string>> = {
    requirements: ['acceptanceCriteria', 'affectedRepos'],
    specs: ['apiEndpoints', 'tablesTouched', 'testBehaviors'],
    tasks: ['filesPlanned'],
    build: ['changeBrief'],
    validate: ['openQuestions'],
  };
  for (let j = fromIndex; j <= toIndex; j++) {
    const stage = STAGES[j];
    const fields = stageFields[stage.name];
    if (!fields) continue;
    for (const f of fields) {
      try {
        deps.manifestStore.patchField(
          deps.config.project, deps.featureSlug(),
          f as never, 'unset', null as never, `rerun-from-${stage.name}`,
        );
      } catch { /* best-effort — extractor may not have run */ }
    }
  }
  deps.invalidateManifestCache();
}
