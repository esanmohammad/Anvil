// Extract critical flows from project YAML for smoke testing

import type { CriticalFlow, Project } from '../project/types.js';

export interface SmokeFlow {
  id: string;
  name: string;
  trigger?: string;
  steps: SmokeFlowStep[];
}

export interface SmokeFlowStep {
  component: string;
  action: string;
  httpInterface?: string;
  notes?: string;
}

/**
 * Extract critical flows from a parsed project config and convert
 * to SmokeFlow format suitable for test generation.
 */
export function extractCriticalFlows(project: Project): SmokeFlow[] {
  const criticalFlows = project.critical_flows ?? [];

  return criticalFlows.map((flow: CriticalFlow) => ({
    id: flow.id,
    name: flow.name,
    trigger: flow.trigger,
    steps: (flow.steps ?? []).map((step) => ({
      component: step.component,
      action: step.action,
      httpInterface: step.interface,
      notes: step.notes,
    })),
  }));
}
