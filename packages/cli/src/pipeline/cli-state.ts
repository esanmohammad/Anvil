/**
 * CliPipelineState — typed shared-state record threaded through every
 * step in cli's pipeline. Phase 6 of CORE-PIPELINE-CONSOLIDATION-PLAN.
 *
 * Each step's `ctx.shared` is cast to this interface. Steps read inputs
 * from `ctx.shared.<field>` and write per-stage outputs that downstream
 * steps consume.
 */

import type { AffectedProject } from './types.js';
import type { AgentRunner } from './stages/types.js';
import type { MemoryStore } from './memory-store-cli.js';
import type { RunStore, CostEntry } from '../run/index.js';

export interface CliPipelineState {
  // Identity
  project: string;
  feature: string;
  featureSlug: string;
  runId: string;
  runDir: string;
  startedAt: number;

  // Workspace + repos
  workspaceDir: string;
  repoPaths: Record<string, string>;
  repoNames: string[];
  projectYamlPath: string | undefined;

  // Runtime deps
  agentRunner: AgentRunner;
  projectLoader: {
    findProject: (name: string) => Promise<{ project: string; repos: { name: string; path?: string }[] }>;
    loadAll: () => Promise<{ project: string; repos: { name: string; path?: string }[] }[]>;
  };
  memoryStore: MemoryStore;
  runStore: RunStore;

  // Config flags
  approvalRequired: boolean;
  skipShip: boolean;
  skipClarify: boolean;
  answersFile?: string;
  actionType: 'feature' | 'bugfix' | 'fix' | 'spike' | 'review';
  deploy: 'local' | 'remote' | false;
  failureContext?: string;
  resumeFromStage: number;
  model?: string;

  // Stage outputs (mutated as steps run; downstream steps read these)
  clarificationArtifact: string;
  highLevelReqsArtifact: string;
  affectedProjects: AffectedProject[];
  repoReqsMap: Map<string, string>;
  projectSpecsMap: Map<string, string>;
  projectTasksMap: Map<string, string>;
  validationArtifact: string;

  // Final outputs
  prUrls: string[];
  sandboxUrl?: string;

  // Per-stage cost accumulator (kept as a side channel; the bus's
  // attachCostTrackerHook also accumulates from event payloads)
  stageCosts: Map<number, CostEntry>;
}
