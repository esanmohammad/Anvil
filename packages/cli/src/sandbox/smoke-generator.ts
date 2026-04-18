// Generate HTTP smoke tests from critical flows

import type { SmokeFlow } from './smoke-flows.js';

export interface SmokeTest {
  flowId: string;
  flowName: string;
  sequence: SmokeTestStep[];
}

export interface SmokeTestStep {
  name: string;
  method: string;
  url: string;
  expectedStatus: number;
  body?: string;
  headers?: Record<string, string>;
}

/**
 * Convert critical flows into executable HTTP test sequences.
 * Each step that has an httpInterface is turned into a test request.
 * Steps without explicit HTTP info get a default GET to the component path.
 */
export function generateSmokeTests(
  flows: SmokeFlow[],
  sandboxUrl: string,
): SmokeTest[] {
  const baseUrl = sandboxUrl.replace(/\/+$/, '');

  return flows.map((flow) => {
    const sequence: SmokeTestStep[] = [];

    for (const step of flow.steps) {
      const { method, path } = parseInterface(step.httpInterface);
      sequence.push({
        name: `${flow.name} / ${step.action}`,
        method,
        url: `${baseUrl}${path ?? `/${step.component}`}`,
        expectedStatus: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // If flow has no steps, add a health-check style request
    if (sequence.length === 0) {
      sequence.push({
        name: `${flow.name} / health`,
        method: 'GET',
        url: `${baseUrl}/health`,
        expectedStatus: 200,
      });
    }

    return {
      flowId: flow.id,
      flowName: flow.name,
      sequence,
    };
  });
}

function parseInterface(iface?: string): { method: string; path?: string } {
  if (!iface) {
    return { method: 'GET' };
  }

  // Format: "GET /api/resource" or "POST /api/resource"
  const match = iface.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(.+)$/i);
  if (match) {
    return { method: match[1].toUpperCase(), path: match[2] };
  }

  // If it looks like a path, default to GET
  if (iface.startsWith('/')) {
    return { method: 'GET', path: iface };
  }

  return { method: 'GET' };
}
