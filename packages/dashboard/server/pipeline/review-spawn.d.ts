/**
 * PR-review agent spawner (Phase 3 round-3 extraction from
 * `dashboard-server.ts`).
 *
 * `createReviewSpawn(deps)` returns the bundle:
 *   - `startReviewRun`      — kick off a PR review: prepasses + N persona agents
 *   - `finalizeReviewAgent` — parse each persona's output, filter, persist
 *   - `applyReviewFix`      — apply a suggestedFix patch to the PR branch
 *   - `reviewAgentContext`  — Map exposed for the agent-event router
 *
 * Behaviour is preserved verbatim; closure deps come through the
 * `deps` bag. Most heavy lifting (security prepass, convention rules,
 * plan compliance, KB context, evidence gate, R3 verifier, scope
 * matcher, convention filter, calibration, dismissals, GitHub
 * annotator) stays as dynamic imports.
 */
import type { AgentManager, AgentState } from '@esankhan3/anvil-agent-core';
import type { PlanStore } from '../plan-store.js';
import type { ProjectLoader } from '../project-loader.js';
import type { DashboardServices } from '../services/index.js';
import { type Review, type Persona, type ReviewStore } from '../review-store.js';
import type { ReviewCalibrationStore } from '../review-calibration.js';
import type { ReviewDismissalStore } from '../review-dismissal-store.js';
import type { BoundTestsStore } from '../bound-tests.js';
export interface ReviewAgentContextEntry {
    reviewId: string;
    project: string;
    persona: Persona;
    repoLocalPath?: string;
    diffText?: string;
    fileContents?: Record<string, string>;
}
export interface ReviewSpawnDeps {
    anvilHome: string;
    conventionPaths: {
        conventionsDir: string;
        rulesDir: string;
    };
    agentManager: AgentManager;
    planStore: PlanStore;
    projectLoader: ProjectLoader;
    services: DashboardServices;
    reviewStore: ReviewStore;
    reviewCalibrationStore: ReviewCalibrationStore;
    reviewDismissalStore: ReviewDismissalStore;
    boundTestsStore: BoundTestsStore;
    getWorkspaceFromConfig: (project: string) => string | null;
}
export interface ReviewSpawnHandle {
    startReviewRun: (project: string, prUrl: string, trigger: Review['trigger'], personas: Persona[], modelId?: string, priorReview?: Review) => Promise<void>;
    finalizeReviewAgent: (agentId: string, agent: AgentState) => Promise<void>;
    applyReviewFix: (project: string, reviewId: string, findingId: string) => Promise<string>;
    reviewAgentContext: Map<string, ReviewAgentContextEntry>;
}
export declare function createReviewSpawn(deps: ReviewSpawnDeps): ReviewSpawnHandle;
//# sourceMappingURL=review-spawn.d.ts.map