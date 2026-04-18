// Ship stage integration — wires sandbox, smoke tests, fix loop, and PR creation
//
// Deployment is fully optional:
//   1. If pipeline.ship.deploy is set in factory.yaml, use that command
//   2. If ANVIL_DEPLOY_CMD env var is set, use that
//   3. Otherwise, skip deployment entirely (just create PRs)

import type { Project } from '../../project/types.js';
import { deployUp, type ExecCommand as DeployExecCommand } from '../../sandbox/deploy-up.js';
import { deployHealthCheck, type FetchFn as HealthFetchFn } from '../../sandbox/deploy-health.js';
import { extractCriticalFlows } from '../../sandbox/smoke-flows.js';
import { generateSmokeTests } from '../../sandbox/smoke-generator.js';
import { runSmokeTests, type FetchFn as SmokeFetchFn } from '../../sandbox/smoke-runner.js';
import { smokeFixLoop, type FixFn, type RedeployFn } from '../../sandbox/smoke-fix-loop.js';
import { formatSmokeReport } from '../../sandbox/smoke-reporter.js';
import { createAllPrs, type RepoConfig } from '../../ship/pr-orchestrator.js';
import type { PrBodyContext } from '../../ship/pr-body-builder.js';
import type { ExecCommand as PrExecCommand } from '../../ship/pr-creator.js';
import type { DeployConfig } from '../../sandbox/deploy-types.js';

export interface ShipStageInput {
  project: Project;
  runId: string;
  featureSlug: string;
  featureSummary: string;
  validationSummary: string;
  repos: RepoConfig[];
  branchName: string;
  cost?: { estimatedCost: number };
  keepSandbox?: boolean;
  labels?: string[];
  /** Deploy command from factory.yaml pipeline.ship.deploy */
  deployCommand?: string;
  /** If true, skip deployment entirely (just create PRs) */
  skipDeploy?: boolean;
}

export interface ShipStageDeps {
  deployExecCommand?: DeployExecCommand;
  prExecCommand?: PrExecCommand;
  healthFetchFn?: HealthFetchFn;
  smokeFetchFn?: SmokeFetchFn;
  fixFn?: FixFn;
  redeployFn?: RedeployFn;
  deployConfig?: Partial<DeployConfig>;
}

export interface ShipStageOutput {
  sandboxUrl?: string;
  sandboxHealthy: boolean;
  smokeReport: string;
  smokesPassed: boolean;
  prUrls: string[];
  skipped: boolean;
}

/**
 * Stage 7 — Ship: deploy sandbox, run smoke tests, fix loop, create PRs.
 *
 * Deployment resolution:
 *   1. input.deployCommand (from factory.yaml pipeline.ship.deploy)
 *   2. ANVIL_DEPLOY_CMD env var
 *   3. Skip deployment entirely — just create PRs
 */
export async function runShipStageIntegration(
  input: ShipStageInput,
  deps: ShipStageDeps = {},
): Promise<ShipStageOutput> {
  let sandboxUrl: string | undefined;
  let sandboxHealthy = false;
  let smokeReport = '';
  let smokesPassed = false;

  // Determine if deployment should run
  const hasConfigDeploy = !!input.deployCommand;
  const hasEnvDeploy = !!(process.env.ANVIL_DEPLOY_CMD || process.env.FF_DEPLOY_CMD);
  const shouldDeploy = !input.skipDeploy && (hasConfigDeploy || hasEnvDeploy || !!deps.deployConfig);

  if (shouldDeploy) {
    // Step 1: Deploy sandbox
    const deployResult = await deployUp(
      input.project.project,
      deps.deployConfig,
      deps.deployExecCommand,
    );

    if (deployResult.success && deployResult.environment) {
      sandboxUrl = deployResult.environment.ingressUrl;

      // Step 2: Health check
      const healthResult = await deployHealthCheck(
        deployResult.environment,
        deps.healthFetchFn,
      );
      sandboxHealthy = healthResult.healthy;
    }

    // Step 3: Smoke tests
    if (sandboxUrl && sandboxHealthy) {
      const flows = extractCriticalFlows(input.project);
      const smokeTests = generateSmokeTests(flows, sandboxUrl);

      const initialResults = await runSmokeTests(smokeTests, deps.smokeFetchFn);
      const allPassed = initialResults.every((r) => r.passed);

      if (allPassed) {
        smokesPassed = true;
        smokeReport = formatSmokeReport(initialResults);
      } else if (deps.fixFn && deps.redeployFn) {
        // Step 4: Fix loop
        const fixResult = await smokeFixLoop(
          smokeTests,
          initialResults,
          deps.fixFn,
          deps.redeployFn,
          { maxAttempts: 3, fetchFn: deps.smokeFetchFn },
        );
        smokesPassed = fixResult.success;
        smokeReport = formatSmokeReport(fixResult.finalResults, fixResult.attempts);
      } else {
        smokeReport = formatSmokeReport(initialResults);
      }
    }
  } else {
    console.log('[ship] No deploy command configured — skipping sandbox deployment');
  }

  // Step 5: Create PRs (always runs, regardless of deployment)
  const prContext: PrBodyContext = {
    featureSummary: input.featureSummary,
    featureSlug: input.featureSlug,
    sandboxUrl,
    validationSummary: input.validationSummary,
    cost: input.cost,
    runId: input.runId,
  };

  const prResult = await createAllPrs(
    input.repos,
    prContext,
    deps.prExecCommand,
    input.labels,
  );

  const prUrls = prResult.prs
    .filter((p) => p.result.success)
    .map((p) => p.result.url);

  return {
    sandboxUrl,
    sandboxHealthy,
    smokeReport,
    smokesPassed,
    prUrls,
    skipped: false,
  };
}
