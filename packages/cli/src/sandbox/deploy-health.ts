// deploy health check — verify sandbox environment health

import type { DeployEnvironment } from './deploy-types.js';

export interface HealthCheckResult {
  healthy: boolean;
  ingressReachable: boolean;
  allPodsReady: boolean;
  details: string[];
}

export type FetchFn = (url: string) => Promise<{ ok: boolean; status: number }>;

const defaultFetchFn: FetchFn = async (url: string) => {
  const response = await fetch(url);
  return { ok: response.ok, status: response.status };
};

/**
 * Check sandbox health: ping ingress URL and verify pod readiness.
 */
export async function deployHealthCheck(
  env: DeployEnvironment,
  fetchFn: FetchFn = defaultFetchFn,
): Promise<HealthCheckResult> {
  const details: string[] = [];
  let ingressReachable = false;

  // Check ingress URL
  if (env.ingressUrl) {
    try {
      const { ok, status } = await fetchFn(env.ingressUrl);
      ingressReachable = ok;
      details.push(
        ingressReachable
          ? `Ingress OK (HTTP ${status})`
          : `Ingress unhealthy (HTTP ${status})`,
      );
    } catch (err) {
      details.push(
        `Ingress unreachable: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  } else {
    details.push('No ingress URL configured');
  }

  // Check pod readiness
  const allPodsReady =
    env.podStatuses.length > 0 && env.podStatuses.every((p) => p.ready);

  if (env.podStatuses.length === 0) {
    details.push('No pods found');
  } else {
    for (const pod of env.podStatuses) {
      if (pod.ready) {
        details.push(`Pod ${pod.name}: Ready (${pod.status})`);
      } else {
        details.push(
          `Pod ${pod.name}: NotReady (${pod.status}, restarts: ${pod.restarts})`,
        );
      }
    }
  }

  return {
    healthy: ingressReachable && allPodsReady,
    ingressReachable,
    allPodsReady,
    details,
  };
}
