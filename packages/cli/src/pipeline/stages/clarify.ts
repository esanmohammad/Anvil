// Stage 0: Clarify — two-phase interactive Q&A
//
// Phase 1: Agent explores codebase and generates clarifying questions.
// Phase 2: Pipeline pauses (pendingApproval), user answers in dashboard.
// Phase 3: Agent runs again with user answers to produce CLARIFICATION.md.

import { readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { checkpointStage } from '../../checkpoint/checkpoint-writer.js';
import {
  setPendingApproval,
  readDashboardState,
  drainUserMessages,
} from '../state-file.js';
import type { StageContext, StageOutput } from './types.js';

export interface ClarifyOptions {
  skipClarify: boolean;
  answersFile?: string;
}

const STAGE_ID = 0;
const STAGE_NAME = 'clarify';
const ARTIFACT_NAME = 'CLARIFICATION.md';

export async function runClarifyStage(
  ctx: StageContext,
  options: ClarifyOptions,
): Promise<StageOutput> {
  let artifact: string;
  let tokenEstimate = 0;

  if (options.skipClarify) {
    artifact = '# Clarification\n\nClarification skipped.\n';
  } else if (options.answersFile) {
    const raw = await readFile(options.answersFile, 'utf8');
    artifact = `# Clarification\n\n${raw}\n`;
  } else {
    const workingDir = resolveWorkingDir(ctx);

    const projectContext = ctx.projectYamlPath && existsSync(ctx.projectYamlPath)
      ? `\n\nProject definition:\n${await readFile(ctx.projectYamlPath, 'utf8')}`
      : '';

    const repoList = ctx.repoPaths
      ? Object.entries(ctx.repoPaths)
          .map(([name, path]) => `  - ${name}: ${path}`)
          .join('\n')
      : '  (no repos resolved)';

    // ── Phase 1: Explore codebase and generate questions ──────────────
    const questionsResult = await ctx.agentRunner.run({
      persona: 'clarifier',
      projectPrompt: `You are a clarification agent for the Anvil pipeline.

Your ONLY job in this phase is to explore the codebase and generate clarifying questions.
Do NOT produce a CLARIFICATION.md yet. Just output your questions.

Project: ${ctx.project}
Repos in this project:
${repoList}
${projectContext}`,
      userPrompt: `Feature request: "${ctx.feature}"

Explore the codebase to understand the current architecture, then output 3-5 clarifying questions about this feature request. Number each question. Be specific — reference actual files, APIs, or patterns you found in the code.`,
      workingDir,
      stage: STAGE_NAME,
    });

    tokenEstimate += questionsResult.tokenEstimate;
    const questions = questionsResult.output;

    // ── Phase 2: Wait for user answers ────────────────────────────────
    // Set pendingApproval so the dashboard shows the approve/answer UI.
    // The user types answers in the input bar, which get stored as userMessages.
    // We poll until pendingApproval is cleared (user clicks Approve).
    setPendingApproval(STAGE_ID);

    const answers = await waitForUserAnswers();

    // ── Phase 3: Produce CLARIFICATION.md with answers ────────────────
    const clarifyResult = await ctx.agentRunner.run({
      persona: 'clarifier',
      projectPrompt: `You are a clarification agent. Produce a final CLARIFICATION.md artifact.
You have the original questions and the user's answers. Synthesize them into a clear document.`,
      userPrompt: `Feature: "${ctx.feature}"

## Questions asked:
${questions}

## User answers:
${answers || '(No answers provided — user approved without answering. Proceed with best assumptions.)'}

Produce a CLARIFICATION.md that summarizes the feature, incorporates the answers, lists assumptions, and notes any remaining constraints.`,
      workingDir,
      stage: STAGE_NAME,
    });

    artifact = clarifyResult.output;
    tokenEstimate += clarifyResult.tokenEstimate;
  }

  await checkpointStage(ctx.runDir, STAGE_ID, STAGE_NAME, artifact);

  return { artifact, artifactName: ARTIFACT_NAME, tokenEstimate };
}

/**
 * Wait for the user to answer clarifying questions.
 * Polls the state file every 500ms until pendingApproval is cleared.
 * Collects any userMessages that were sent during the wait.
 */
async function waitForUserAnswers(): Promise<string> {
  return new Promise((resolve) => {
    const collectedMessages: string[] = [];
    const interval = setInterval(() => {
      // Drain any messages the user has sent
      const messages = drainUserMessages();
      if (messages.length > 0) {
        collectedMessages.push(...messages);
      }

      // Check if approval was cleared (user clicked Approve)
      const state = readDashboardState();
      if (!state.activePipeline || !state.activePipeline.pendingApproval) {
        clearInterval(interval);
        resolve(collectedMessages.join('\n\n'));
      }
    }, 500);
  });
}

/**
 * Resolve the best working directory for an agent.
 */
function resolveWorkingDir(ctx: StageContext): string {
  if (ctx.workspaceDir && existsSync(ctx.workspaceDir)) {
    const entries = readdirSync(ctx.workspaceDir).filter((e: string) => !e.startsWith('.'));
    if (entries.length > 0) return ctx.workspaceDir;
  }
  if (ctx.repoPaths) {
    for (const p of Object.values(ctx.repoPaths)) {
      if (existsSync(p)) return p;
    }
  }
  if (ctx.projectYamlPath) {
    const projectDir = dirname(ctx.projectYamlPath);
    if (existsSync(projectDir)) return projectDir;
  }
  const projectConfigDir = process.env.ANVIL_PROJECT_DIR || process.env.FF_PROJECT_DIR
    || join(homedir(), '.anvil', 'projects');
  if (existsSync(projectConfigDir)) return projectConfigDir;
  return ctx.runDir;
}
