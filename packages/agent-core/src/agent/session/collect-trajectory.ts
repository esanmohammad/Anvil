/**
 * `collectTrajectory` — eval-facing entry point. Spawns an `AgentProcess`,
 * listens to its 5-event surface, and aggregates an Inspect-AI-shaped
 * `AgentTrajectory`.
 *
 * Replaces the headless `runAgent` entry. Same trajectory contract, but
 * routed through the production execution path (`AgentProcess` +
 * `defaultAdapterFactory`) so eval runs exercise the same code the
 * dashboard and cli do — including skills + MCP discovery via
 * `workspace.rootDir`.
 *
 * Per AGENT-PROCESS-CONSOLIDATION-ADR §C1.
 */

import { randomBytes } from 'node:crypto';
import { AgentProcess, type AgentProcessOpts } from './session.js';
import { defaultAdapterFactory } from './default-adapter-factory.js';
import type { AgentActivity, CostInfo, SpawnConfig } from './types.js';
import type {
  AgentTask,
  AgentTrajectory,
  TrajectoryMessage,
  TrajectoryToolCall,
  WorkspaceConfig,
} from './headless-types.js';

export interface CollectTrajectoryOptions {
  /** Abort-by-signal. When fired, calls `proc.kill()` and resolves with
   *  `finishReason: 'error'`, `error: 'aborted'`. */
  signal?: AbortSignal;
  /** Wall-clock timeout in ms (default 600_000 — 10 minutes). */
  timeoutMs?: number;
  /**
   * Optional override for the `AgentProcess` opts (factory injection,
   * test seams). Production callers omit; tests use to inject scripted
   * adapters.
   */
  processOpts?: Partial<AgentProcessOpts>;
}

const DEFAULT_TIMEOUT_MS = 600_000;
const ANSWER_PLACEHOLDER = '';

/**
 * Run a task to completion and return its Inspect-AI-shaped trajectory.
 *
 * Listener-first ordering: every event handler is attached BEFORE
 * `proc.start()` so the first `content` chunk doesn't slip through.
 */
export async function collectTrajectory(
  task: AgentTask,
  workspace: WorkspaceConfig,
  opts: CollectTrajectoryOptions = {},
): Promise<AgentTrajectory> {
  const startedAt = Date.now();
  const spec = taskToSpawnConfig(task, workspace);
  const processOpts: AgentProcessOpts = {
    adapterFactory: defaultAdapterFactory,
    ...opts.processOpts,
  };

  const proc = new AgentProcess(spec, processOpts);

  const messages: TrajectoryMessage[] = [];
  if (task.systemPrompt) {
    messages.push({ role: 'system', content: task.systemPrompt });
  }
  messages.push({ role: 'user', content: task.prompt });

  const toolCalls: TrajectoryToolCall[] = [];
  const toolCallByName = new Map<string, TrajectoryToolCall>();

  let assistantBuffer = '';
  let finalAnswer = ANSWER_PLACEHOLDER;
  let cost: CostInfo | null = null;
  let resolvedSessionId = spec.runId ?? proc.id;
  let errorText = '';

  const flushAssistantBuffer = () => {
    if (!assistantBuffer) return;
    messages.push({ role: 'assistant', content: assistantBuffer });
    assistantBuffer = '';
  };

  return new Promise<AgentTrajectory>((resolve) => {
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | null = null;

    const finish = (
      finishReason: AgentTrajectory['finishReason'],
      errorOverride?: string,
    ) => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) clearTimeout(timeoutHandle);
      flushAssistantBuffer();

      const durationMs = Date.now() - startedAt;
      const usage = cost
        ? {
            inputTokens: cost.inputTokens,
            outputTokens: cost.outputTokens,
            ...(cost.cacheReadTokens
              ? { cacheReadTokens: cost.cacheReadTokens }
              : {}),
            ...(cost.cacheWriteTokens
              ? { cacheWriteTokens: cost.cacheWriteTokens }
              : {}),
          }
        : { inputTokens: 0, outputTokens: 0 };

      const finalErrorText = errorOverride ?? errorText.trim();
      const trajectory: AgentTrajectory = {
        messages,
        toolCalls,
        model: spec.model,
        usage,
        costUsd: cost?.totalUsd ?? 0,
        finalAnswer: finalAnswer || assistantBuffer,
        finishReason,
        durationMs,
        ...(finishReason === 'error' && finalErrorText
          ? { error: finalErrorText }
          : {}),
      };

      resolve(trajectory);
    };

    // ── Listener wiring (before start) ─────────────────────────────────
    proc.on('content', (chunk: string) => {
      assistantBuffer += chunk;
    });

    proc.on('activity', (activity: AgentActivity) => {
      if (activity.kind !== 'tool_use' || !activity.tool) return;
      // Flush any accumulated assistant text BEFORE the tool message so
      // ordering reflects the run.
      flushAssistantBuffer();
      let parsedArgs: Record<string, unknown> = {};
      if (typeof activity.content === 'string' && activity.content.trim()) {
        try {
          parsedArgs = JSON.parse(activity.content) as Record<string, unknown>;
        } catch {
          parsedArgs = { _raw: activity.content };
        }
      }
      const call: TrajectoryToolCall = {
        callId: activity.id,
        name: activity.tool,
        arguments: parsedArgs,
        durationMs: 0,
      };
      toolCalls.push(call);
      toolCallByName.set(activity.id, call);
      messages.push({
        role: 'tool',
        content: '',
        name: activity.tool,
        toolCallId: activity.id,
      });
    });

    proc.on('result', (data: { result: string; cost: CostInfo; sessionId: string }) => {
      cost = data.cost;
      finalAnswer = data.result || assistantBuffer;
      resolvedSessionId = data.sessionId;
      // Don't finish here — wait for `exit` so adapters that emit result
      // before exit (the common case) and after exit (sub-second races)
      // both settle deterministically on the exit event.
    });

    proc.on('error-output', (text: string) => {
      errorText += text;
    });

    proc.on('exit', (code: number | null) => {
      // Surface the resolvedSessionId on the last assistant message via a
      // suffix is unnecessary; the trajectory shape doesn't carry session
      // id today. Reserved here so future schema bumps can grab it.
      void resolvedSessionId;
      if (code === null) {
        finish('error', 'killed');
      } else if (code !== 0) {
        finish('error');
      } else {
        finish(cost ? 'end' : 'error', cost ? undefined : errorText.trim() || 'no result');
      }
    });

    // ── Abort + timeout ────────────────────────────────────────────────
    if (opts.signal) {
      if (opts.signal.aborted) {
        proc.kill();
        finish('error', 'aborted');
        return;
      }
      opts.signal.addEventListener(
        'abort',
        () => {
          proc.kill();
          finish('error', 'aborted');
        },
        { once: true },
      );
    }

    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    timeoutHandle = setTimeout(() => {
      proc.kill();
      finish('error', 'timeout');
    }, timeoutMs);

    // ── Start ──────────────────────────────────────────────────────────
    proc.start();
  });
}

/**
 * Map an `AgentTask` + `WorkspaceConfig` to a `SpawnConfig`. Internal
 * helper — eval consumers stay on the `(task, workspace)` shape.
 */
function taskToSpawnConfig(
  task: AgentTask,
  workspace: WorkspaceConfig,
): SpawnConfig {
  const runId = task.taskId ?? `eval-${randomBytes(4).toString('hex')}`;
  return {
    name: task.taskId ?? 'eval-task',
    persona: 'eval',
    project: 'eval',
    stage: 'eval',
    prompt: task.prompt,
    model: task.model,
    cwd: workspace.rootDir,
    workspaceDir: workspace.rootDir,
    projectPrompt: task.systemPrompt,
    allowedTools: task.allowedTools,
    maxOutputTokens: task.maxTokens,
    runId,
    runFamily: runId,
  };
}
