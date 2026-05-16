/**
 * `runner-prep` — constructor + pre-loop setup helpers extracted
 * from `pipeline-runner.ts`.
 *
 * `resolveWorkspaceDir` reads the workspace path from the project's
 * factory.yaml / project.yaml (with env-var + default fallback).
 *
 * `prepareRun` owns the run() body's pre-loop block: feature record
 * creation/resume, manifest ensure + plan-seed pre-fill, prior-artifact
 * load on resume, hybrid-context prefetch, knowledge-base presence
 * check + project-event surfacing.
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  populateManifestFromPlan as populateManifestFromPlanBridge,
  type ManifestBridgeDeps,
} from './manifest-bridge.js';
import type { FeatureManifestStore } from './feature-manifest.js';
import type { FeatureStore } from './feature-store.js';
import type { KnowledgeBaseManager } from './knowledge-base-manager.js';
import { loadPriorArtifacts as loadPriorArtifactsFn, type ArtifactIODeps } from './artifact-io.js';
import {
  STAGES,
  type PipelineConfig,
  type PipelineRunState,
} from './pipeline-runner-types.js';

export interface RunnerPrepDeps {
  config: PipelineConfig;
  state: PipelineRunState;
  featureStore: FeatureStore;
  manifestStore: FeatureManifestStore;
  kbManager: KnowledgeBaseManager | null;
  depsForManifest: () => ManifestBridgeDeps;
  depsForArtifactIO: () => ArtifactIODeps;
  emit: (event: 'warning' | 'project-event', payload: unknown) => void;
}

export interface RunnerPrepResult {
  isResume: boolean;
  resumeStage: number;
  prevArtifact: string;
}

/** Resolve the workspace path: factory.yaml/project.yaml override → env → default. */
export function resolveWorkspaceDir(project: string): string {
  const anvilHome = process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil');
  const candidates = [
    join(anvilHome, 'projects', project, 'factory.yaml'),
    join(anvilHome, 'projects', project, 'project.yaml'),
  ];
  for (const cp of candidates) {
    if (!existsSync(cp)) continue;
    try {
      const raw = readFileSync(cp, 'utf-8');
      const wsMatch = raw.match(/^workspace:\s+(.+)$/m);
      if (wsMatch) {
        const resolved = wsMatch[1].replace(/^["']|["']$/g, '').trim().replace(/^~/, homedir());
        if (existsSync(resolved)) return resolved;
      }
    } catch { /* ignore */ }
  }
  const wsRoot = process.env.ANVIL_WORKSPACE_ROOT || process.env.FF_WORKSPACE_ROOT || join(homedir(), 'workspace');
  return join(wsRoot, project);
}

export async function prepareRun(deps: RunnerPrepDeps): Promise<RunnerPrepResult> {
  const isResume = deps.config.resumeFromStage != null && !!deps.config.featureSlug;

  // Feature record — resume by slug or create new.
  if (isResume) {
    let featureRecord = deps.featureStore.getFeature(deps.config.project, deps.config.featureSlug!);
    if (!featureRecord) {
      featureRecord = deps.featureStore.createFeature(deps.config.project, deps.config.feature, deps.config.model);
    }
    deps.state.featureSlug = deps.config.featureSlug!;
  } else {
    const featureRecord = deps.featureStore.createFeature(deps.config.project, deps.config.feature, deps.config.model);
    deps.state.featureSlug = featureRecord.slug;
  }

  // Manifest ensure + plan-seed pre-fill.
  deps.manifestStore.ensure(deps.config.project, deps.state.featureSlug, deps.config.feature);
  if (deps.config.planSeed?.plan) {
    try {
      populateManifestFromPlanBridge(deps.depsForManifest(), deps.config.planSeed.plan);
    } catch (err) {
      console.warn('[pipeline] populateManifestFromPlan failed:', err);
    }
  }

  // Prior artifacts on resume.
  let prevArtifact = '';
  const resumeStage = deps.config.resumeFromStage ?? 0;
  if (isResume) {
    prevArtifact = loadPriorArtifactsFn(deps.depsForArtifactIO());
    console.log(
      `[pipeline] Resuming from stage ${resumeStage} (${STAGES[resumeStage]?.name}), `
      + `loaded ${prevArtifact.length} chars of prior context`,
    );
  }

  // Hybrid retriever prefetch — failures are non-fatal.
  try {
    await deps.kbManager?.prefetchHybridContext(deps.config.project, deps.config.feature);
  } catch (err) {
    console.warn(`[pipeline] prefetchHybridContext failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  // KB presence surfacing.
  const kbCheck = deps.kbManager?.getIndexForPrompt(deps.config.project)
    || deps.kbManager?.getAllGraphReports(deps.config.project)
    || '';
  if (!kbCheck) {
    console.warn(
      `[pipeline] WARNING: No knowledge base for "${deps.config.project}" — agents will explore codebase manually. Build the KB from the dashboard for faster, cheaper runs.`,
    );
    deps.emit('warning', {
      message: `Knowledge base not built for "${deps.config.project}". Agents will explore the codebase manually, which is slower and more expensive. Build the KB from the Knowledge Graph page for better results.`,
    });
    deps.emit('project-event', {
      source: 'knowledge-base',
      message: `No Knowledge Base found for "${deps.config.project}" — agents will explore codebase manually (slower + costlier). Build the KB from the Knowledge Graph page.`,
      level: 'warn',
    });
  } else {
    deps.emit('project-event', {
      source: 'knowledge-base',
      message: `Knowledge Base ready for "${deps.config.project}" (${kbCheck.length} chars) — will inject into agent prompts for faster, cheaper runs`,
    });
  }

  return { isResume, resumeStage, prevArtifact };
}
