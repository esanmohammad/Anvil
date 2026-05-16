/**
 * `clarify-stage` step factory — full 3-phase clarify orchestration.
 *
 * Phase H7 — promoted from
 * `packages/dashboard/server/steps/clarify-stage.step.ts` into
 * `core-pipeline/src/steps`. Refactored to require an `AgentSession`
 * (multi-turn agent surface) — the legacy `AgentManager` fallback is
 * dropped from the canonical path. The dashboard's
 * `AgentManagerSession` satisfies `AgentSession`; cli will wire its own
 * session implementation when its consolidation lands.
 *
 * The 3 phases mirror legacy behavior exactly:
 *   - Phase A (explore):    session.start() with the explore prompt
 *   - Phase B (Q&A loop):   parse + dispatch via inputResolver
 *   - Phase C (synthesize): session.sendInput() against the SAME agentId
 */

import type { Step, StepContext } from '../types.js';
import type { AgentSession } from '../agent-session.js';
import type { ClarifyQAPair } from '../stages/clarify.js';
import {
  parseClarifyQuestions,
  formatQAPairs,
  buildClarifySynthesisPrompt,
} from '../stages/clarify.js';

const CLARIFY_DISALLOWED_TOOLS: readonly string[] = [
  'Write', 'Edit', 'NotebookEdit', 'Bash',
];

export interface RunClarifyForProjectOptions {
  /** Multi-turn agent surface (required). Dashboard injects `AgentManagerSession`. */
  agentSession: AgentSession;
  project: string;
  workspaceDir: string;
  model: string;
  maxOutputTokens?: number;
  /** Pre-built explore-phase user prompt. */
  explorePrompt: string;
  /** Pre-built per-stage project (system) prompt. */
  projectPrompt: string;
  inputResolver: (question: string, qIndex: number, qTotal: number) => Promise<string>;
  isCancelled: () => boolean;
  onAgentSpawned?: (agentId: string) => void;
  onClarifyQuestion?: (questionIndex: number, totalQuestions: number, question: string) => void;
  onWaitingForInput?: (agentId: string) => void;
  onAnswerReceived?: (answer: string) => void;
  onClarifyAck?: (questionIndex: number, totalQuestions: number, hasMore: boolean) => void;
  onSynthesizeStart?: () => void;
  allowedTools?: string[];
}

export interface RunClarifyForProjectResult {
  artifact: string;
  cost: number;
  agentId: string;
  questions: string[];
  qaPairs: ClarifyQAPair[];
  synthesizeRan: boolean;
  cancelled: boolean;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

export async function runClarifyForProject(
  opts: RunClarifyForProjectOptions,
): Promise<RunClarifyForProjectResult> {
  // Phase A — explore.
  const exploreResult = await opts.agentSession.start({
    persona: 'clarifier',
    projectPrompt: opts.projectPrompt,
    userPrompt: opts.explorePrompt,
    workingDir: opts.workspaceDir,
    stage: 'clarify',
    model: opts.model,
    allowedTools: opts.allowedTools,
    disallowedTools: [...CLARIFY_DISALLOWED_TOOLS],
    maxOutputTokens: opts.maxOutputTokens,
  });
  const explore = {
    agentId: exploreResult.sessionId,
    artifact: exploreResult.output,
    cost: exploreResult.costUsd ?? 0,
    inputTokens: exploreResult.inputTokens ?? 0,
    outputTokens: exploreResult.outputTokens ?? 0,
    cacheReadTokens: exploreResult.cacheReadTokens ?? 0,
    cacheWriteTokens: exploreResult.cacheWriteTokens ?? 0,
  };
  opts.onAgentSpawned?.(explore.agentId);

  let totalCost = explore.cost;

  // Phase B — Q&A loop.
  const parsed = parseClarifyQuestions(explore.artifact);
  const trimmedArtifact = explore.artifact.trim();
  let questions: string[];
  if (parsed.length > 0) {
    questions = parsed;
  } else if (trimmedArtifact.length > 0) {
    questions = [trimmedArtifact];
  } else {
    console.warn(
      `[clarify] model produced no parseable text for ${opts.project}; ` +
      `agentId=${explore.agentId}. Falling back to a generic clarifier question.`,
    );
    questions = [
      'I could not generate clarifying questions automatically. ' +
      'Please describe the feature in more detail — scope, constraints, ' +
      'edge cases, and any acceptance criteria you have in mind.',
    ];
  }

  const qaPairs: ClarifyQAPair[] = [];
  let cancelled = false;

  for (let qi = 0; qi < questions.length; qi += 1) {
    if (opts.isCancelled()) { cancelled = true; break; }
    const question = questions[qi];
    opts.onClarifyQuestion?.(qi, questions.length, question);
    opts.onWaitingForInput?.(explore.agentId);

    let answer: string;
    try {
      answer = await opts.inputResolver(question, qi, questions.length);
    } catch {
      cancelled = true;
      break;
    }

    if (opts.isCancelled() || !answer) { cancelled = true; break; }

    qaPairs.push({ question, answer });
    opts.onAnswerReceived?.(answer);
    opts.onClarifyAck?.(qi, questions.length, qi < questions.length - 1);
  }

  // Phase C — synthesize (only when ≥1 Q&A pair landed AND not cancelled).
  if (cancelled || qaPairs.length === 0) {
    return {
      artifact: explore.artifact,
      cost: totalCost,
      agentId: explore.agentId,
      questions, qaPairs,
      synthesizeRan: false, cancelled,
      inputTokens: explore.inputTokens,
      outputTokens: explore.outputTokens,
      cacheReadTokens: explore.cacheReadTokens,
      cacheWriteTokens: explore.cacheWriteTokens,
    };
  }

  opts.onSynthesizeStart?.();

  const synthesisPrompt = buildClarifySynthesisPrompt(formatQAPairs(qaPairs));
  const synthResult = await opts.agentSession.sendInput(explore.agentId, synthesisPrompt);
  const synthesize = {
    artifact: synthResult.output,
    cost: synthResult.costUsd ?? 0,
    inputTokens: synthResult.inputTokens ?? 0,
    outputTokens: synthResult.outputTokens ?? 0,
    cacheReadTokens: synthResult.cacheReadTokens ?? 0,
    cacheWriteTokens: synthResult.cacheWriteTokens ?? 0,
  };

  totalCost += synthesize.cost;

  return {
    artifact: synthesize.artifact || explore.artifact,
    cost: totalCost,
    agentId: explore.agentId,
    questions, qaPairs,
    synthesizeRan: true, cancelled: false,
    inputTokens: explore.inputTokens + synthesize.inputTokens,
    outputTokens: explore.outputTokens + synthesize.outputTokens,
    cacheReadTokens: explore.cacheReadTokens + synthesize.cacheReadTokens,
    cacheWriteTokens: explore.cacheWriteTokens + synthesize.cacheWriteTokens,
  };
}

export interface ClarifyStageStepOptions {
  id?: string;
  agentSession: AgentSession;
  project: string;
  workspaceDir: string;
  model: string;
  maxOutputTokens?: number;
  buildExplorePrompt: () => string;
  buildProjectPrompt: () => string;
  inputResolver: (question: string, qIndex: number, qTotal: number) => Promise<string>;
  onAgentSpawned?: (agentId: string) => void;
  onClarifyQuestion?: (questionIndex: number, totalQuestions: number, question: string) => void;
  onWaitingForInput?: (agentId: string) => void;
  onAnswerReceived?: (answer: string) => void;
  onClarifyAck?: (questionIndex: number, totalQuestions: number, hasMore: boolean) => void;
  onSynthesizeStart?: () => void;
  isCancelled?: (ctx: StepContext<unknown>) => boolean;
  allowedTools?: string[];
}

export function createClarifyStageStep(
  opts: ClarifyStageStepOptions,
): Step<unknown, RunClarifyForProjectResult> {
  const id = opts.id ?? 'clarify-stage';
  return {
    id,
    name: 'Clarify stage (explore + Q&A + synthesize)',
    parallelism: 'serial',
    async run(ctx: StepContext<unknown>): Promise<RunClarifyForProjectResult> {
      const isCancelled = opts.isCancelled
        ? () => opts.isCancelled!(ctx)
        : () => ctx.signal.aborted;

      return runClarifyForProject({
        agentSession: opts.agentSession,
        project: opts.project,
        workspaceDir: opts.workspaceDir,
        model: opts.model,
        maxOutputTokens: opts.maxOutputTokens,
        explorePrompt: opts.buildExplorePrompt(),
        projectPrompt: opts.buildProjectPrompt(),
        inputResolver: opts.inputResolver,
        isCancelled,
        onAgentSpawned: opts.onAgentSpawned,
        onClarifyQuestion: opts.onClarifyQuestion,
        onWaitingForInput: opts.onWaitingForInput,
        onAnswerReceived: opts.onAnswerReceived,
        onClarifyAck: opts.onClarifyAck,
        onSynthesizeStart: opts.onSynthesizeStart,
        allowedTools: opts.allowedTools,
      });
    },
  };
}
