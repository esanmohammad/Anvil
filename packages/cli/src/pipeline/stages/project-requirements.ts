// Stage 2: Project Requirements (parallel per project)

import { checkpointStage } from '../../checkpoint/checkpoint-writer.js';
import type { StageContext, StageOutput } from './types.js';

const STAGE_ID = 2;
const STAGE_NAME = 'project-requirements';
const ARTIFACT_NAME = 'REQUIREMENTS.md';

export async function runProjectRequirementsStage(
  ctx: StageContext,
  highLevelReqs: string,
  project: { name: string; repos: string[] },
): Promise<StageOutput> {
  const userPrompt = [
    `# High-Level Requirements\n\n${highLevelReqs}`,
    `# Project: ${project.name}`,
    `# Repos\n\n${project.repos.map((r) => `- ${r}`).join('\n')}`,
  ].join('\n\n');

  const result = await ctx.agentRunner.run({
    persona: 'analyst',
    projectPrompt:
      `You are a requirements analyst. Produce project-specific requirements for the "${project.name}" project ` +
      `based on the high-level requirements. Focus on the repos: ${project.repos.join(', ')}.`,
    userPrompt,
    workingDir: ctx.workspaceDir ?? ctx.runDir,
    stage: STAGE_NAME,
  });

  const artifact = result.output;

  await checkpointStage(
    ctx.runDir,
    STAGE_ID,
    STAGE_NAME,
    artifact,
    undefined,
    project.name,
  );

  return {
    artifact,
    artifactName: `${project.name}-${ARTIFACT_NAME}`,
    tokenEstimate: result.tokenEstimate,
  };
}
