import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const STAGE_ORDER = [
  'clarify',
  'high-level-requirements',
  'requirements',
  'spec',
  'tasks',
  'build',
  'test',
];

const STAGE_FILES: Record<string, string> = {
  clarify: 'CLARIFICATION.md',
  'high-level-requirements': 'HIGH-LEVEL-REQUIREMENTS.md',
  requirements: 'REQUIREMENTS.md',
  spec: 'SPEC.md',
  tasks: 'TASKS.md',
  build: 'BUILD-OUTPUT.md',
  test: 'TEST-REPORT.md',
};

export function getStageOrder(): string[] {
  return [...STAGE_ORDER];
}

export async function collectPriorArtifacts(
  runDir: string,
  upToStage: string,
): Promise<Record<string, string>> {
  const artifacts: Record<string, string> = {};
  const stageIndex = STAGE_ORDER.indexOf(upToStage);
  if (stageIndex <= 0) return artifacts; // No prior stages for first stage

  for (let i = 0; i < stageIndex; i++) {
    const stage = STAGE_ORDER[i];
    const filename = STAGE_FILES[stage];
    if (!filename) continue;

    const filePath = join(runDir, filename);
    if (existsSync(filePath)) {
      try {
        artifacts[stage] = await readFile(filePath, 'utf-8');
      } catch {
        // Skip unreadable artifacts
      }
    }
  }

  return artifacts;
}
