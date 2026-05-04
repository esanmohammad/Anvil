/**
 * `anvil run --task "<prompt>"` — headless agent run for cli + eval consumers.
 *
 * Two modes:
 *   - Streaming (default): spawns AgentProcess directly, pipes content to
 *     stdout as it arrives, surfaces tool activity on stderr (one short
 *     line per tool use). Exit code reflects the adapter's exit.
 *   - JSON (--json): wraps the same call via collectTrajectory and writes
 *     the resulting AgentTrajectory as one JSON object to stdout. Designed
 *     for piping into jq or eval scripts.
 *
 * Per AGENT-PROCESS-CONSOLIDATION-PLAN Phase 3.
 */

import { Command } from 'commander';
import { resolve as resolvePath } from 'node:path';
import {
  AgentProcess,
  collectTrajectory,
  defaultAdapterFactory,
  type AgentActivity,
  type CostInfo,
  type SpawnConfig,
} from '@anvil/agent-core';
import { error as logError } from '../logger.js';

const DEFAULT_MODEL = 'claude-sonnet-4-6';
const DEFAULT_TIMEOUT_MS = 600_000;

export const runCommand = new Command('run')
  .description('Run a one-shot agent task headlessly (no pipeline).')
  .requiredOption('--task <prompt>', 'Task statement (becomes the user prompt).')
  .option('--model <id>', `Model identifier (default: ${DEFAULT_MODEL}).`, DEFAULT_MODEL)
  .option('--workspace <dir>', 'Workspace root for skills + MCP discovery (default: cwd).')
  .option('--timeout <ms>', `Wall-clock timeout in milliseconds (default: ${DEFAULT_TIMEOUT_MS}).`, String(DEFAULT_TIMEOUT_MS))
  .option('--json', 'Emit the full AgentTrajectory as JSON to stdout instead of streaming text.')
  .option('--system-prompt <prompt>', 'Optional system-prompt prefix.')
  .action(async (opts: RunOpts) => {
    const workspace = resolvePath(opts.workspace ?? process.cwd());
    const timeoutMs = parseTimeout(opts.timeout);

    if (opts.json) {
      await runJsonMode(opts, workspace, timeoutMs);
      return;
    }
    await runStreamingMode(opts, workspace, timeoutMs);
  });

interface RunOpts {
  task: string;
  model: string;
  workspace?: string;
  timeout?: string;
  json?: boolean;
  systemPrompt?: string;
}

function parseTimeout(raw: string | undefined): number {
  if (!raw) return DEFAULT_TIMEOUT_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_TIMEOUT_MS;
  return Math.floor(n);
}

async function runJsonMode(opts: RunOpts, workspace: string, timeoutMs: number): Promise<void> {
  const traj = await collectTrajectory(
    {
      prompt: opts.task,
      model: opts.model,
      systemPrompt: opts.systemPrompt,
    },
    { rootDir: workspace },
    { timeoutMs },
  );
  process.stdout.write(JSON.stringify(traj, null, 2) + '\n');
  if (traj.finishReason === 'error') {
    process.exitCode = traj.error === 'timeout' ? 124 : 1;
  }
}

async function runStreamingMode(
  opts: RunOpts,
  workspace: string,
  timeoutMs: number,
): Promise<void> {
  const spec: SpawnConfig = {
    name: 'cli-run',
    persona: 'cli',
    project: 'cli',
    stage: 'cli-run',
    prompt: opts.task,
    model: opts.model,
    cwd: workspace,
    workspaceDir: workspace,
    projectPrompt: opts.systemPrompt,
  };

  const proc = new AgentProcess(spec, { adapterFactory: defaultAdapterFactory });

  const timeoutHandle = setTimeout(() => {
    logError(`anvil run: timeout after ${timeoutMs}ms — killing agent`);
    proc.kill();
    process.exitCode = 124;
  }, timeoutMs);
  timeoutHandle.unref?.();

  let lastExit: number | null = null;
  let didResult = false;

  proc.on('content', (chunk: string) => {
    process.stdout.write(chunk);
  });
  proc.on('activity', (activity: AgentActivity) => {
    if (activity.kind === 'tool_use') {
      process.stderr.write(`[tool] ${activity.summary}\n`);
    }
  });
  proc.on('result', (data: { result: string; cost: CostInfo; sessionId: string }) => {
    didResult = true;
    void data;
  });
  proc.on('error-output', (text: string) => {
    process.stderr.write(text);
  });

  await new Promise<void>((resolveDone) => {
    proc.on('exit', (code: number | null) => {
      clearTimeout(timeoutHandle);
      lastExit = code;
      // Newline so the shell prompt reappears cleanly after streamed output.
      if (process.stdout.isTTY) process.stdout.write('\n');
      resolveDone();
    });
    proc.start();
  });

  if (lastExit !== null && lastExit !== 0) {
    process.exitCode = lastExit;
  } else if (!didResult) {
    process.exitCode = 1;
  }
}
