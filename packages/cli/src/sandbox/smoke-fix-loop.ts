// Smoke test fix loop — fix, redeploy, retest cycle

import type { SmokeTest } from './smoke-generator.js';
import type { SmokeTestResult, FetchFn } from './smoke-runner.js';
import { runSmokeTests } from './smoke-runner.js';

export interface FixAttempt {
  attempt: number;
  failedFlows: string[];
  fixed: boolean;
}

export interface FixLoopResult {
  success: boolean;
  attempts: FixAttempt[];
  finalResults: SmokeTestResult[];
}

export type FixFn = (failures: SmokeTestResult[]) => Promise<boolean>;
export type RedeployFn = () => Promise<boolean>;

/**
 * Run a fix loop: if smoke tests fail, call fixFn, redeploy, and retest.
 * Maximum of maxAttempts iterations (default 3).
 */
export async function smokeFixLoop(
  tests: SmokeTest[],
  initialResults: SmokeTestResult[],
  fixFn: FixFn,
  redeployFn: RedeployFn,
  options: {
    maxAttempts?: number;
    fetchFn?: FetchFn;
  } = {},
): Promise<FixLoopResult> {
  const maxAttempts = options.maxAttempts ?? 3;
  const attempts: FixAttempt[] = [];
  let currentResults = initialResults;

  for (let i = 0; i < maxAttempts; i++) {
    const failures = currentResults.filter((r) => !r.passed);
    if (failures.length === 0) {
      return { success: true, attempts, finalResults: currentResults };
    }

    // Attempt fix
    const fixed = await fixFn(failures);
    attempts.push({
      attempt: i + 1,
      failedFlows: failures.map((f) => f.flowId),
      fixed,
    });

    if (!fixed) {
      return { success: false, attempts, finalResults: currentResults };
    }

    // Redeploy
    const redeployed = await redeployFn();
    if (!redeployed) {
      return { success: false, attempts, finalResults: currentResults };
    }

    // Retest
    currentResults = await runSmokeTests(
      tests,
      options.fetchFn,
    );
  }

  // After all attempts, check final state
  const allPassed = currentResults.every((r) => r.passed);
  return { success: allPassed, attempts, finalResults: currentResults };
}
