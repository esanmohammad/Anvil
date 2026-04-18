// Stage 1: High-Level Requirements

import { checkpointStage } from '../../checkpoint/checkpoint-writer.js';
import type { StageContext, StageOutput } from './types.js';

const STAGE_ID = 1;
const STAGE_NAME = 'requirements';
const ARTIFACT_NAME = 'HIGH-LEVEL-REQUIREMENTS.md';

export async function runHighLevelRequirementsStage(
  ctx: StageContext,
  clarification: string,
): Promise<StageOutput> {
  const userPrompt = [
    `# Feature Request\n\n${ctx.feature}`,
    `# Clarification\n\n${clarification}`,
    `# Project\n\n${ctx.project}`,
  ].join('\n\n');

  const result = await ctx.agentRunner.run({
    persona: 'analyst',
    projectPrompt:
      'You are a requirements analyst. Produce high-level requirements from the feature request and clarification. ' +
      'Your output MUST include a "## Success Criteria" section.',
    userPrompt,
    workingDir: ctx.workspaceDir ?? ctx.runDir,
    stage: STAGE_NAME,
  });

  const artifact = result.output;

  // Validate that Success Criteria section exists
  if (!artifact.includes('## Success Criteria')) {
    throw new Error(
      'High-level requirements output is missing required "## Success Criteria" section',
    );
  }

  await checkpointStage(ctx.runDir, STAGE_ID, STAGE_NAME, artifact);

  return {
    artifact,
    artifactName: ARTIFACT_NAME,
    tokenEstimate: result.tokenEstimate,
  };
}
