/**
 * Claude CLI ModelAdapter.
 *
 * The simplest adapter — Claude CLI already outputs Anvil Stream Format
 * natively (`--output-format stream-json`), so we just pipe stdout through
 * with zero transformation.
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import type {
  ModelAdapter,
  ModelAdapterConfig,
  ModelAdapterResult,
  ProviderCapabilities,
  ProviderName,
} from './types.js';
import type { ResultMessage } from './stream-format.js';
import { UpstreamError, synthesizeStatusFromCli } from './upstream-error.js';
import { createNullTurnRecorder } from './turn-recorder/index.js';

// ---------------------------------------------------------------------------
// Pricing table — [inputPer1M, outputPer1M]
// ---------------------------------------------------------------------------

const PRICING: Record<string, [number, number]> = {
  sonnet: [3.0, 15.0],
  opus: [15.0, 75.0],
  haiku: [0.25, 1.25],
};

function pricingKeyFromModel(modelId: string): string | undefined {
  const lower = modelId.toLowerCase();
  for (const key of Object.keys(PRICING)) {
    if (lower.includes(key)) return key;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

function resolveBinary(): string {
  return (
    process.env.ANVIL_AGENT_CMD ??
    process.env.FF_AGENT_CMD ??
    process.env.CLAUDE_BIN ??
    'claude'
  );
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class ClaudeAdapter implements ModelAdapter {
  readonly provider: ProviderName = 'claude';

  readonly capabilities: ProviderCapabilities = {
    tier: 'agentic',
    streaming: true,
    toolUse: true,
    fileSystem: true,
    shellExecution: true,
    sessionResume: true,
    promptCaching: true,
    cache: 'explicit',
    cacheTtlSeconds: 300,
    structuredOutput: 'tool-shim',
    // Claude CLI doesn't expose a max-tokens flag today; bridges/router callers
    // may pass it but the adapter ignores it.
    maxOutputTokens: false,
  };

  // Per-call subprocess tracking. `ClaudeAdapter` is registered as a
  // singleton, so a scalar `child` field gets trampled by concurrent
  // `run()` calls (per-repo backend + frontend in parallel). The set
  // mirrors the pattern used by Ollama / OpenRouter adapters.
  private readonly children = new Set<ChildProcess>();

  supportsModel(modelId: string): boolean {
    const lower = modelId.toLowerCase();
    return (
      lower.startsWith('claude-') ||
      lower.includes('sonnet') ||
      lower.includes('opus') ||
      lower.includes('haiku')
    );
  }

  getModelPricing(modelId: string): [number, number] | null {
    const key = pricingKeyFromModel(modelId);
    return key ? PRICING[key] : null;
  }

  async checkAvailability(): Promise<{ available: boolean; version?: string; error?: string }> {
    try {
      const bin = resolveBinary();
      const version = execSync(`${bin} --version`, { encoding: 'utf-8', timeout: 10_000 }).trim();
      return { available: true, version };
    } catch (err) {
      return { available: false, error: (err as Error).message };
    }
  }

  async run(config: ModelAdapterConfig, output: NodeJS.WritableStream): Promise<ModelAdapterResult> {
    const bin = resolveBinary();
    const startTime = Date.now();

    // ---- Build args -------------------------------------------------------
    const args: string[] = [
      '-p', config.userPrompt,
      '--output-format', 'stream-json',
      '--verbose',
    ];

    if (config.projectPrompt) {
      // Claude CLI's flag is --system-prompt (replaces default) or
      // --append-system-prompt (extends default). The legacy
      // single-shot.ts uses --system-prompt. We follow that convention
      // since the dashboard's projectPrompt is a full persona prompt.
      args.push('--system-prompt', config.projectPrompt);
    }
    if (config.model) {
      args.push('--model', config.model);
    }
    // Claude CLI: --session-id starts a NEW session with that UUID;
    // --resume <id> continues an existing one. The two flags are mutually
    // exclusive — passing both makes the CLI exit non-zero immediately.
    if (config.resume && config.sessionId) {
      args.push('--resume', config.sessionId);
    } else if (config.sessionId) {
      args.push('--session-id', config.sessionId);
    } else if (config.resume) {
      args.push('--resume');
    }
    if (config.permissionMode) {
      args.push('--permission-mode', config.permissionMode);
    }
    if (config.allowedTools?.length) {
      args.push('--allowedTools', config.allowedTools.join(','));
    }
    if (config.disallowedTools?.length) {
      args.push('--disallowedTools', config.disallowedTools.join(','));
    }
    if (config.mcpConfigPath) {
      // Claude CLI: --mcp-config points at an mcp.json that claude-cli
      // reads to bootstrap MCP server connections. defaultAdapterFactory
      // resolves the path from the spawn's workspaceDir.
      args.push('--mcp-config', config.mcpConfigPath);
    }

    // §H4 cross-vendor turn recording — record this exchange so a later
    // resume (possibly a different provider) can reconstruct prior turns via
    // `reconstructSessionHistory`. claude-cli runs its own tool loop opaquely,
    // so the turn is recorded as a single text exchange (no per-tool effects).
    // Deliberately NO replay-skip: claude pipes rich stream-json (tool_result
    // frames carry PR URLs); re-running it on a same-runId resume preserves
    // that full output, whereas re-emitting only the recorded text would drop
    // it. The single assistant-start key is the deterministic prompt hash, so
    // replay matches without a DeterminismViolation. NullTurnRecorder no-ops
    // without a durable recorder.
    const recorder = config.turnRecorder ?? createNullTurnRecorder({
      runId: config.sessionId,
      stepId: config.stage,
    });
    const { turn } = await recorder.startTurn({
      model: config.model,
      provider: 'claude',
      system: config.projectPrompt,
      messages: [{ role: 'user', content: config.userPrompt }],
      userPrompt: config.userPrompt,
    });

    // ---- Spawn ------------------------------------------------------------
    const child = spawn(bin, args, {
      cwd: config.workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.children.add(child);
    // Bulletproof cleanup regardless of how this run() exits — `close`
    // fires after both stdout/stderr have closed and the process has
    // exited, which covers normal exit, throws, and `kill()`.
    child.once('close', () => { this.children.delete(child); });

    // End stdin immediately — prompt is passed via args
    child.stdin!.end();

    // Forward stderr to process.stderr while ALSO buffering it so we
    // can scan for retryable upstream conditions (rate-limit, quota,
    // overload) on a non-zero exit. Capped to 16 KB to avoid blowing
    // memory on a chatty failure.
    let stderrBuf = '';
    const STDERR_CAP = 16 * 1024;
    child.stderr!.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      if (stderrBuf.length < STDERR_CAP) {
        stderrBuf += chunk.toString('utf8').slice(0, STDERR_CAP - stderrBuf.length);
      }
    });

    // ---- Pipe stdout & capture result in parallel -------------------------
    let resultMsg: ResultMessage | null = null;
    let fullOutput = '';
    let toolCallCount = 0;
    // Anthropic stream-json stamps stop_reason on the assistant frame, not
    // the result frame, so we cache the most recent one and surface it on
    // ModelAdapterResult below.
    let lastStopReason: string | undefined;

    // We read stdout line-by-line to capture the result message while also
    // piping every line to the output writable unchanged.
    const rl = createInterface({ input: child.stdout!, crlfDelay: Infinity });

    rl.on('line', (line) => {
      // Pipe through unchanged
      output.write(line + '\n');

      // Try to parse the result message
      try {
        const parsed = JSON.parse(line);
        if (parsed.type === 'result') {
          resultMsg = parsed as ResultMessage;
          fullOutput = parsed.result ?? '';
        } else if (parsed.type === 'assistant' && Array.isArray(parsed.message?.content)) {
          // Count tool_use blocks for telemetry; pure-pipe semantics preserved.
          for (const block of parsed.message.content) {
            if (block?.type === 'tool_use') toolCallCount += 1;
          }
          if (typeof parsed.message?.stop_reason === 'string') {
            lastStopReason = parsed.message.stop_reason;
          }
        }
      } catch {
        // Not JSON — pass through silently
      }
    });

    // ---- Wait for exit ----------------------------------------------------
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on('close', (code) => resolve(code ?? 0));
      child.on('error', reject);
    });

    const durationMs = Date.now() - startTime;

    if (exitCode !== 0 && !resultMsg) {
      // Try to classify the failure from stderr so the dashboard's
      // chain-fallback can hop to another provider on a quota/rate-limit
      // hit instead of dying. Anthropic's CLI surfaces these as
      // "rate_limit_error", "overloaded_error", "Credit balance is too
      // low", or HTTP-style status numbers in the stderr body.
      const synth = synthesizeStatusFromCli(stderrBuf);
      if (synth) {
        throw new UpstreamError(synth.status, stderrBuf || `Claude CLI exited with code ${exitCode}`, {
          provider: 'claude',
          retryable: synth.retryable,
        });
      }
      throw new Error(`Claude CLI exited with code ${exitCode}${stderrBuf ? `\n${stderrBuf.slice(0, 400)}` : ''}`);
    }

    // Exit 0 with no result message: claude-cli ended its stream-json
    // output without emitting the terminating `result` frame. Observed
    // intermittently under parallel spawns. Surface as retryable so the
    // dashboard's chain-fallback re-resolves to the next chain entry
    // instead of writing an empty artifact downstream.
    if (!resultMsg) {
      throw new UpstreamError(
        503,
        stderrBuf || 'Claude CLI exited 0 with no result message',
        { provider: 'claude', retryable: true },
      );
    }

    // ---- Build result -----------------------------------------------------
    const pricing = this.getModelPricing(config.model) ?? [3.0, 15.0];
    const rm = resultMsg as Record<string, any> | null;
    const inputTokens = rm?.usage?.input_tokens ?? 0;
    const outputTokens = rm?.usage?.output_tokens ?? 0;
    const cacheReadTokens = rm?.usage?.cache_read_input_tokens ?? 0;
    const cacheWriteTokens = rm?.usage?.cache_creation_input_tokens ?? 0;
    const costUsd =
      rm?.total_cost_usd ??
      (inputTokens * pricing[0] + outputTokens * pricing[1]) / 1_000_000;

    // Empty output combined with zero output tokens means claude-cli
    // recorded a result frame but the assistant produced nothing. Treat
    // as transient — same retry semantics as a missing result frame.
    if (!fullOutput && outputTokens === 0) {
      throw new UpstreamError(
        503,
        'Claude CLI returned empty output with 0 output tokens',
        { provider: 'claude', retryable: true },
      );
    }

    // §H4 — record the completed turn (assistant-end). Only on success: the
    // empty-output / missing-result cases threw above, so we never persist an
    // empty assistant-end.
    await recorder.endTurn(
      turn,
      fullOutput,
      lastStopReason ?? 'end_turn',
      { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens },
      { segments: [{ model: config.model, provider: 'claude', range: [0, fullOutput.length], source: 'live' }] },
    );

    return {
      output: fullOutput,
      inputTokens,
      outputTokens,
      costUsd,
      durationMs,
      sessionId: rm?.session_id,
      provider: 'claude' as const,
      model: config.model,
      cacheReadTokens,
      cacheWriteTokens,
      toolCallCount,
      stopReason: lastStopReason,
    };
  }

  kill(): void {
    for (const child of this.children) {
      if (!child.killed) child.kill('SIGTERM');
    }
    this.children.clear();
  }
}
