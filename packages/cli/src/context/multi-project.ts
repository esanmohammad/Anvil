import type { Project } from '../project/types.js';
import type { PersonaName } from '../personas/types.js';
import { assembleContext, type AssemblyResult } from './assembler.js';

const CROSS_SYSTEM_STAGES = ['clarify', 'high-level-requirements'];

export async function assembleMultiProjectContext(
  persona: PersonaName,
  projects: Project[],
  runDir: string,
  featureRequest: string,
  stage?: string,
): Promise<Record<string, AssemblyResult>> {
  const currentStage = stage || persona;

  if (CROSS_SYSTEM_STAGES.includes(currentStage)) {
    // For cross-project stages, combine all projects into one merged project context
    const merged: Project = {
      ...projects[0],
      project: projects.map(s => s.project).join('+'),
      repos: projects.flatMap(s => s.repos),
      invariants: projects.flatMap(s => s.invariants || []),
      sharp_edges: projects.flatMap(s => s.sharp_edges || []),
      critical_flows: projects.flatMap(s => s.critical_flows || []),
    };
    const result = await assembleContext(persona, merged, runDir, featureRequest, currentStage);
    return { '_cross_project': result };
  }

  // Per-project stages: assemble in parallel
  const results: Record<string, AssemblyResult> = {};
  const promises = projects.map(async (sys) => {
    const systemRunDir = `${runDir}/${sys.project}`;
    const result = await assembleContext(persona, sys, systemRunDir, featureRequest, currentStage);
    results[sys.project] = result;
  });
  await Promise.all(promises);

  return results;
}
