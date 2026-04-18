// Stage 3: Project Specs (parallel per project)

import { checkpointStage } from '../../checkpoint/checkpoint-writer.js';
import type { StageContext, StageOutput } from './types.js';

const STAGE_ID = 3;
const STAGE_NAME = 'specs';
const ARTIFACT_NAME = 'SPEC.md';

export async function runProjectSpecsStage(
  ctx: StageContext,
  projectRequirements: string,
  project: { name: string; repos: string[] },
): Promise<StageOutput> {
  const userPrompt = [
    `# Project Requirements\n\n${projectRequirements}`,
    `# Project: ${project.name}`,
    `# Repos\n\n${project.repos.map((r) => `- ${r}`).join('\n')}`,
  ].join('\n\n');

  const result = await ctx.agentRunner.run({
    persona: 'architect',
    projectPrompt:
      `You are a project architect. Produce a detailed technical specification for the "${project.name}" project ` +
      `based on the project requirements. Include API changes, data models, and integration points.`,
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
