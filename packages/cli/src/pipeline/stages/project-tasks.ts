// Stage 4: Project Tasks (parallel per project)

import { checkpointStage } from '../../checkpoint/checkpoint-writer.js';
import type { StageContext, StageOutput } from './types.js';

const STAGE_ID = 4;
const STAGE_NAME = 'tasks';
const ARTIFACT_NAME = 'TASKS.md';

export async function runProjectTasksStage(
  ctx: StageContext,
  projectSpec: string,
  project: { name: string; repos: string[] },
): Promise<StageOutput> {
  const userPrompt = [
    `# Project Spec\n\n${projectSpec}`,
    `# Project: ${project.name}`,
    `# Repos\n\n${project.repos.map((r) => `- ${r}`).join('\n')}`,
  ].join('\n\n');

  const result = await ctx.agentRunner.run({
    persona: 'lead',
    projectPrompt:
      `You are a technical lead. Break down the project spec for "${project.name}" into concrete, ` +
      `ordered implementation tasks with file paths and dependencies.`,
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
