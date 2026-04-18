// Execute smoke tests sequentially and capture results

import type { SmokeTest, SmokeTestStep } from './smoke-generator.js';

export interface SmokeTestResult {
  flowId: string;
  flowName: string;
  passed: boolean;
  stepResults: StepResult[];
}

export interface StepResult {
  name: string;
  passed: boolean;
  status: number;
  expectedStatus: number;
  latencyMs: number;
  body?: string;
  error?: string;
}

export type FetchFn = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

const defaultFetchFn: FetchFn = async (url, init) => {
  const response = await fetch(url, init);
  return {
    ok: response.ok,
    status: response.status,
    text: () => response.text(),
  };
};

/**
 * Run smoke tests sequentially, capturing status, body, and latency.
 */
export async function runSmokeTests(
  tests: SmokeTest[],
  fetchFn: FetchFn = defaultFetchFn,
): Promise<SmokeTestResult[]> {
  const results: SmokeTestResult[] = [];

  for (const test of tests) {
    const stepResults: StepResult[] = [];

    for (const step of test.sequence) {
      const result = await executeStep(step, fetchFn);
      stepResults.push(result);
    }

    results.push({
      flowId: test.flowId,
      flowName: test.flowName,
      passed: stepResults.every((r) => r.passed),
      stepResults,
    });
  }

  return results;
}

async function executeStep(
  step: SmokeTestStep,
  fetchFn: FetchFn,
): Promise<StepResult> {
  const start = Date.now();
  try {
    const resp = await fetchFn(step.url, {
      method: step.method,
      headers: step.headers,
      body: step.body,
    });

    const latencyMs = Date.now() - start;
    const body = await resp.text();
    const passed = resp.status === step.expectedStatus;

    return {
      name: step.name,
      passed,
      status: resp.status,
      expectedStatus: step.expectedStatus,
      latencyMs,
      body,
    };
  } catch (err) {
    return {
      name: step.name,
      passed: false,
      status: 0,
      expectedStatus: step.expectedStatus,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
