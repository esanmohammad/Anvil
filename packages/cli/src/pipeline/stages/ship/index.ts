import type { AgentRunner } from '../types.js';
import { deploySandbox, type SandboxResult } from './sandbox.js';
import { runSmokeTest, type SmokeTestResult } from './smoke-test.js';
import { createPullRequests, type PRInfo } from './pr-creator.js';

export type { SandboxResult } from './sandbox.js';
export type { SmokeTestResult } from './smoke-test.js';
export type { PRInfo } from './pr-creator.js';
export { deploySandbox } from './sandbox.js';
export { runSmokeTest } from './smoke-test.js';
export { createPullRequests } from './pr-creator.js';

export interface ShipStageConfig {
  project: string;
  runId: string;
  featureSlug: string;
  repoPaths: Record<string, string>;
  branchName: string;
  validationSummary: string;
  agentRunner: AgentRunner;
  skipShip: boolean;
  cost?: { estimatedCost: number };
}

export interface ShipStageResult {
  sandboxUrl?: string;
  smokeTestPassed: boolean;
  prInfos: PRInfo[];
  skipped: boolean;
}

/**
 * Orchestrates the ship stage:
 * 1. Deploy sandbox
 * 2. Run smoke tests
 * 3. Create pull requests
 */
export async function runShipStage(config: ShipStageConfig): Promise<ShipStageResult> {
  if (config.skipShip) {
    return {
      smokeTestPassed: false,
      prInfos: [],
      skipped: true,
    };
  }

  // Step 1: Deploy sandbox
  const sandboxResult = await deploySandbox(config.project, config.runId);

  // Step 2: Run smoke tests if sandbox is ready
  let smokeTestPassed = false;
  if (sandboxResult.status === 'ready') {
    const smokeResult = await runSmokeTest(sandboxResult.url, ['/health', '/ready']);
    smokeTestPassed = smokeResult.passed;
  }

  // Step 3: Create pull requests
  const prInfos = await createPullRequests(
    config.runId,
    config.featureSlug,
    config.repoPaths,
    config.branchName,
    config.validationSummary,
    sandboxResult.status === 'ready' ? sandboxResult.url : undefined,
    config.cost,
  );

  return {
    sandboxUrl: sandboxResult.status === 'ready' ? sandboxResult.url : undefined,
    smokeTestPassed,
    prInfos,
    skipped: false,
  };
}
