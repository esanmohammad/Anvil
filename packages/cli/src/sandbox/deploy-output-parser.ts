// Parse deploy CLI output into structured data

import type { DeployEnvironment, PodStatus } from './deploy-types.js';

/** Strip ANSI escape codes from a string */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '');
}

/**
 * Parse deploy output to extract namespace, ingress URL, and pod statuses.
 *
 * Expected output patterns:
 *   Namespace: ff-sandbox-abc123
 *   Ingress: https://abc123.sandbox.example.com
 *   Pod: api-7f8d9-xyz  Ready  0  Running
 */
export function parseDeployOutput(raw: string): DeployEnvironment | null {
  const clean = stripAnsi(raw);

  // Extract namespace
  const nsMatch = clean.match(/Namespace:\s*(\S+)/i);
  const namespace = nsMatch?.[1] ?? '';

  // Extract ingress URL
  const ingressMatch = clean.match(/Ingress:\s*(https?:\/\/\S+)/i);
  const ingressUrl = ingressMatch?.[1] ?? '';

  if (!namespace && !ingressUrl) {
    return null;
  }

  // Extract pod statuses — lines like:
  // Pod: <name>  <Ready|NotReady>  <restarts>  <status>
  const podStatuses: PodStatus[] = [];
  const podRegex = /Pod:\s*(\S+)\s+(Ready|NotReady)\s+(\d+)\s+(\S+)/gi;
  let podMatch: RegExpExecArray | null;
  while ((podMatch = podRegex.exec(clean)) !== null) {
    podStatuses.push({
      name: podMatch[1],
      ready: podMatch[2].toLowerCase() === 'ready',
      restarts: parseInt(podMatch[3], 10),
      status: podMatch[4],
    });
  }

  return {
    namespace,
    ingressUrl,
    podStatuses,
  };
}
