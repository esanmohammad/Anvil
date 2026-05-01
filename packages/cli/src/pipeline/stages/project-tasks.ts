// Stage 4: Project Tasks (parallel per project)
//
// The planner is asked to emit BOTH:
//   1. A human-readable plan (markdown)
//   2. A fenced ```json``` block containing a TaskEnvelope[] that
//      conforms to @anvil/core-pipeline's schema.
//
// The JSON block is extracted + validated. On validation failure we
// retry up to MAX_RETRIES times with the structured error fed back to
// the model. If validation never succeeds we still ship the markdown
// artifact (graceful degrade — downstream build stage continues to read
// the same string artifact it always has).

import { checkpointStage } from '../../checkpoint/checkpoint-writer.js';
import type { StageContext, StageOutput } from './types.js';
import { extractTaskEnvelopes, buildRetryPrompt } from '@anvil/core-pipeline';
import type { ExtractResult } from '@anvil/core-pipeline';
import { info, warn } from '../../logger.js';

const STAGE_ID = 4;
const STAGE_NAME = 'tasks';
const ARTIFACT_NAME = 'TASKS.md';
const MAX_RETRIES = 2;

const TASK_ENVELOPE_SCHEMA_HINT = [
  '## Required output format',
  '',
  'Emit the implementation plan as a fenced ```json``` code block at the top of',
  'your response, conforming to TaskEnvelope[]:',
  '',
  '```json',
  '[',
  '  {',
  '    "id": "T-001",',
  '    "repo": "<repo-name>",',
  '    "files_affected": ["src/foo.ts"],',
  '    "operation": "create" | "modify" | "delete",',
  '    "routing": {',
  '      "capability": "code" | "reasoning" | "vision" | "embed" | "rerank",',
  '      "complexity": "S" | "M" | "L",',
  '      "context_estimate_tokens": 8000',
  '    },',
  '    "acceptance_criteria": [',
  '      { "type": "predicate", "check": "exports_symbol", "file": "src/foo.ts", "symbol": "foo" },',
  '      { "type": "prose", "text": "describe a non-mechanical assertion" }',
  '    ]',
  '  }',
  ']',
  '```',
  '',
  'After the JSON block, you may include human-readable narration (file maps,',
  'dependencies, ordering rationale). Downstream consumers read the JSON.',
].join('\n');

export async function runProjectTasksStage(
  ctx: StageContext,
  projectSpec: string,
  project: { name: string; repos: string[] },
): Promise<StageOutput> {
  const baseUserPrompt = [
    `# Project Spec\n\n${projectSpec}`,
    `# Project: ${project.name}`,
    `# Repos\n\n${project.repos.map((r) => `- ${r}`).join('\n')}`,
    TASK_ENVELOPE_SCHEMA_HINT,
  ].join('\n\n');

  const projectPrompt =
    `You are a technical lead. Break down the project spec for "${project.name}" into concrete, ` +
    `ordered implementation tasks with file paths and dependencies. ` +
    `Conform to the TaskEnvelope[] JSON schema described in the user prompt.`;

  let userPrompt = baseUserPrompt;
  let totalTokens = 0;
  let lastOutput = '';
  let validation: ExtractResult | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const result = await ctx.agentRunner.run({
      persona: 'lead',
      projectPrompt,
      userPrompt,
      workingDir: ctx.workspaceDir ?? ctx.runDir,
      stage: STAGE_NAME,
    });
    totalTokens += result.tokenEstimate;
    lastOutput = result.output;
    validation = extractTaskEnvelopes(result.output);

    if (validation.ok) {
      info(`[tasks/${project.name}] envelope validated (${validation.tasks.length} task${validation.tasks.length === 1 ? '' : 's'})`);
      break;
    }

    if (attempt < MAX_RETRIES) {
      info(`[tasks/${project.name}] envelope ${validation.reason}, retrying (${attempt + 1}/${MAX_RETRIES})`);
      userPrompt = [
        baseUserPrompt,
        '---',
        `Your previous attempt:\n\n${result.output}`,
        '---',
        buildRetryPrompt(validation),
      ].join('\n\n');
    }
  }

  if (validation && !validation.ok) {
    warn(
      `[tasks/${project.name}] envelope validation failed after ${MAX_RETRIES + 1} attempts ` +
      `(${validation.reason}); shipping markdown artifact unchanged.`,
    );
  }

  await checkpointStage(
    ctx.runDir,
    STAGE_ID,
    STAGE_NAME,
    lastOutput,
    undefined,
    project.name,
  );

  return {
    artifact: lastOutput,
    artifactName: `${project.name}-${ARTIFACT_NAME}`,
    tokenEstimate: totalTokens,
  };
}
