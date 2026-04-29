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
  };

  private child: ChildProcess | null = null;

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
      args.push('--project-prompt', config.projectPrompt);
    }
    if (config.model) {
      args.push('--model', config.model);
    }
    if (config.sessionId) {
      args.push('--session-id', config.sessionId);
    }
    if (config.resume) {
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

    // ---- Spawn ------------------------------------------------------------
    const child = spawn(bin, args, {
      cwd: config.workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    // End stdin immediately — prompt is passed via args
    child.stdin!.end();

    // Forward stderr to process.stderr
    child.stderr!.pipe(process.stderr);

    // ---- Pipe stdout & capture result in parallel -------------------------
    let resultMsg: ResultMessage | null = null;
    let fullOutput = '';

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

    this.child = null;
    const durationMs = Date.now() - startTime;

    if (exitCode !== 0 && !resultMsg) {
      throw new Error(`Claude CLI exited with code ${exitCode}`);
    }

    // ---- Build result -----------------------------------------------------
    const pricing = this.getModelPricing(config.model) ?? [3.0, 15.0];
    const rm = resultMsg as Record<string, any> | null;
    const inputTokens = rm?.usage?.input_tokens ?? 0;
    const outputTokens = rm?.usage?.output_tokens ?? 0;
    const costUsd =
      rm?.total_cost_usd ??
      (inputTokens * pricing[0] + outputTokens * pricing[1]) / 1_000_000;

    return {
      output: fullOutput,
      inputTokens,
      outputTokens,
      costUsd,
      durationMs,
      sessionId: rm?.session_id,
      provider: 'claude' as const,
      model: config.model,
    };
  }

  kill(): void {
    if (this.child && !this.child.killed) {
      this.child.kill('SIGTERM');
      this.child = null;
    }
  }
}
