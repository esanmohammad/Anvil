/**
 * Shared types for stage logic owned by core-pipeline.
 *
 * Each `runXxxStage(ctx)` function takes a `StageContext` and returns
 * a `StageOutput`. Both consumers (cli + dashboard) build a
 * `StageContext` from their own state and pass it in.
 */

import type { AgentRunner } from '../agent-runner.js';

export interface StageContext {
  /** Run identifier (run-xxx). */
  runId: string;
  /** Run-scoped output directory, typically `~/.anvil/runs/<runId>`. */
  runDir: string;
  /** Project name from project.yaml / factory.yaml. */
  project: string;
  /** User-facing feature description. */
  feature: string;
  /** Slugified feature name used for branch + artifact paths. */
  featureSlug: string;
  /** Workspace directory containing cloned repos for this project. */
  workspaceDir: string;
  /** Map of repo name → local disk path for all repos in this project. */
  repoPaths: Record<string, string>;
  /** Ordered repo names; mirrors `Object.keys(repoPaths)` but stable. */
  repoNames: string[];
  /** The canonical agent invocation surface. */
  agentRunner: AgentRunner;
  /** Optional persona override for this stage; resolver picks one when omitted. */
  persona?: string;
  /** Action type — drives PR labels and prompt nudges. */
  actionType?: 'feature' | 'bugfix' | 'fix' | 'spike' | 'review';
  /** Base branch for PRs. Defaults to `main` when omitted. */
  baseBranch?: string;
  /** Optional path to project.yaml when one exists. */
  projectYamlPath?: string;
}

export interface StageTokens {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export interface StageOutput {
  /** The canonical artifact text — markdown for analysis stages, transcript for build/ship. */
  artifact: string;
  /** Disk-relative filename for this stage's artifact (REQUIREMENTS.md, SPECS.md, …). */
  artifactName?: string;
  /** Per-repo artifacts when the stage is per-repo. */
  repoArtifacts?: Record<string, string>;
  /** Total USD spend for this stage. */
  costUsd: number;
  /** Token usage for this stage (sum across all sub-runs / repos). */
  tokens: StageTokens;
  /** Legacy back-compat — total tokens. */
  tokenEstimate: number;
  /** PR URLs surfaced by ship stage. */
  prUrls?: string[];
  /** Sandbox URL surfaced by ship stage's nexus deploy. */
  sandboxUrl?: string;
  /** Stop reason from the underlying adapter. */
  stopReason?: string;
}

export function emptyStageTokens(): StageTokens {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
}

/**
 * Per-feature scope decision emitted by the `requirements` stage.
 *
 * When present, downstream per-repo stages (specs/tasks/build/test/
 * validate) and ship only act on the repos in `targetRepos`. When
 * absent (LLM didn't emit / parse failed / user supplied explicit
 * `config.repos`), every repo runs — preserving the historical
 * default.
 */
export interface FeatureScope {
  /** Non-empty strict subset of the run's available repoNames. */
  targetRepos: string[];
  /** 1-2 sentences from the LLM for audit + UI surfacing. */
  rationale: string;
}
