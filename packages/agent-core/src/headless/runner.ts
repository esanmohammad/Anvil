/**
 * `runAgent` — headless agent entry point.
 *
 * Glues together:
 *   - Skill loading + activation + render (Phase 1/2)
 *   - MCP server discovery + client connect (Phase 3)
 *   - Built-in tool registry (caller-injected)
 *   - LanguageModel invocation in a tool-call loop
 *   - Trajectory aggregation in the Inspect-AI-compatible shape (ADR §6)
 *
 * Per ADR §6.1:
 *   - Tool-call loop hard cap is `maxToolLoopIterations` (default 25);
 *     hitting it sets `finishReason = 'length'` + an error message.
 *   - MCP clients close cleanly via try/finally even on error path.
 */

import { composeSkillContext } from '../skills/index.js';
import {
  loadMcpServers,
  McpAgentClient,
  buildAgentToolset,
} from '../mcp/index.js';
import type {
  AgentTask,
  AgentTrajectory,
  RunAgentOptions,
  TrajectoryMessage,
  TrajectoryToolCall,
  TrajectoryUsage,
  WorkspaceConfig,
} from './types.js';
import type {
  LanguageModelMessage,
  ToolCall,
} from '../types.js';

const DEFAULT_MAX_TOOL_LOOP_ITERATIONS = 25;
const DEFAULT_TIMEOUT_MS = 600_000;

export async function runAgent(
  task: AgentTask,
  workspace: WorkspaceConfig,
  options: RunAgentOptions,
): Promise<AgentTrajectory> {
  if (!options.model) {
    throw new Error(
      'runAgent: options.model (LanguageModel) is required. As of 2026-04-29, no agent-core adapter implements LanguageModel natively (see observability ADR §3.4); callers must inject one.',
    );
  }

  const startTime = Date.now();
  const maxIterations = options.maxToolLoopIterations ?? DEFAULT_MAX_TOOL_LOOP_ITERATIONS;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = startTime + timeoutMs;

  // Compose system prompt + tool policy from skills (loaded from workspace).
  const skillContext = composeSkillContext(task.systemPrompt ?? '', {
    workspaceRoot: workspace.rootDir,
    allowedTools: task.allowedTools,
  });

  // Discover + instantiate MCP clients (lazy connect on first listTools).
  const mcpServers = loadMcpServers({ workspaceRoot: workspace.rootDir });
  const mcpClients = mcpServers.map((c) => new McpAgentClient(c));

  const messages: TrajectoryMessage[] = [];
  const toolCalls: TrajectoryToolCall[] = [];
  const usage: TrajectoryUsage = { inputTokens: 0, outputTokens: 0 };
  let costUsd = 0;
  let finalAnswer = '';
  let finishReason: AgentTrajectory['finishReason'] = 'end';
  let error: string | undefined;

  try {
    const builtIn = options.builtInTools ?? [];
    const { tools, mcpDispatch } = await buildAgentToolset(builtIn, mcpClients);

    const systemPrompt = skillContext.systemPrompt;
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: task.prompt });

    let iterations = 0;
    while (iterations < maxIterations) {
      if (Date.now() > deadline) {
        finishReason = 'error';
        error = `runAgent: wall-clock timeout exceeded (${timeoutMs}ms)`;
        break;
      }
      iterations++;

      const llmMessages = toLanguageModelMessages(messages);
      let result;
      try {
        result = await options.model.invoke({
          model: task.model,
          messages: llmMessages,
          tools: tools.length > 0 ? tools : undefined,
          maxTokens: task.maxTokens,
          temperature: task.temperature,
        });
      } catch (err) {
        finishReason = 'error';
        error = `LanguageModel.invoke failed: ${(err as Error).message}`;
        break;
      }

      usage.inputTokens += result.usage.inputTokens;
      usage.outputTokens += result.usage.outputTokens;
      addOptionalUsage(usage, 'cacheReadTokens', result.usage.cacheReadTokens);
      addOptionalUsage(usage, 'cacheWriteTokens', result.usage.cacheWriteTokens);
      costUsd += result.costUsd;

      messages.push({
        role: 'assistant',
        content: result.text,
      });

      if (!result.toolCalls || result.toolCalls.length === 0) {
        finalAnswer = result.text;
        finishReason = result.finishReason === 'length' ? 'length' : 'end';
        break;
      }

      finishReason = 'tool-use';
      for (const call of result.toolCalls) {
        if (Date.now() > deadline) {
          finishReason = 'error';
          error = `runAgent: wall-clock timeout exceeded mid-tool-loop (${timeoutMs}ms)`;
          break;
        }
        const callRecord = await dispatchToolCall(
          call,
          mcpDispatch,
          options.builtInDispatch,
          workspace,
        );
        toolCalls.push(callRecord);
        messages.push({
          role: 'tool',
          name: call.name,
          toolCallId: call.id,
          content: JSON.stringify(
            callRecord.error ? { error: callRecord.error } : callRecord.result ?? null,
          ),
        });
      }
      if (finishReason === 'error') break;
    }

    if (iterations >= maxIterations && finishReason === 'tool-use') {
      finishReason = 'length';
      error = `runAgent: tool-loop iterations exhausted (${maxIterations})`;
    }
  } finally {
    await Promise.all(
      mcpClients.map((c) => c.close().catch(() => {})),
    );
  }

  return {
    messages,
    toolCalls,
    model: task.model,
    usage,
    costUsd,
    finalAnswer,
    finishReason,
    error,
    durationMs: Date.now() - startTime,
  };
}

function toLanguageModelMessages(messages: TrajectoryMessage[]): LanguageModelMessage[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content,
    toolCallId: m.toolCallId,
  }));
}

function addOptionalUsage(
  usage: TrajectoryUsage,
  key: 'cacheReadTokens' | 'cacheWriteTokens',
  value: number | undefined,
): void {
  if (typeof value !== 'number') return;
  usage[key] = (usage[key] ?? 0) + value;
}

async function dispatchToolCall(
  call: ToolCall,
  mcpDispatch: Map<string, import('../mcp/client.js').McpAgentClient>,
  builtInDispatch: RunAgentOptions['builtInDispatch'],
  workspace: WorkspaceConfig,
): Promise<TrajectoryToolCall> {
  const callStart = Date.now();
  let result: unknown;
  let errorMsg: string | undefined;
  try {
    const mcpClient = mcpDispatch.get(call.name);
    if (mcpClient) {
      result = await mcpClient.callTool(call.name, call.arguments);
    } else if (builtInDispatch) {
      result = await builtInDispatch(call.name, call.arguments, workspace);
    } else {
      errorMsg = `No dispatcher for tool "${call.name}" (no MCP route, no builtInDispatch provided)`;
    }
  } catch (err) {
    errorMsg = (err as Error).message;
  }
  return {
    callId: call.id,
    name: call.name,
    arguments: call.arguments,
    result,
    error: errorMsg,
    durationMs: Date.now() - callStart,
  };
}
