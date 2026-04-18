export interface SmokeTestResult {
  passed: boolean;
  checks: Array<{ name: string; passed: boolean; details: string }>;
}

type FetchFn = (url: string) => Promise<{ ok: boolean; status: number }>;

const defaultFetchFn: FetchFn = async (url: string) => {
  const response = await fetch(url);
  return { ok: response.ok, status: response.status };
};

/**
 * Runs health endpoint checks against a sandbox URL.
 */
export async function runSmokeTest(
  sandboxUrl: string,
  healthEndpoints: string[],
  fetchFn: FetchFn = defaultFetchFn,
): Promise<SmokeTestResult> {
  const checks: Array<{ name: string; passed: boolean; details: string }> = [];

  for (const endpoint of healthEndpoints) {
    const url = `${sandboxUrl.replace(/\/+$/, '')}${endpoint}`;
    try {
      const { ok, status } = await fetchFn(url);
      checks.push({
        name: endpoint,
        passed: ok,
        details: ok ? `HTTP ${status} OK` : `HTTP ${status} — not ok`,
      });
    } catch (error) {
      checks.push({
        name: endpoint,
        passed: false,
        details: `Error: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
  }

  return {
    passed: checks.every((c) => c.passed),
    checks,
  };
}
