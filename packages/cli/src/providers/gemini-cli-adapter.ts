/**
 * Gemini CLI ModelAdapter.
 *
 * Spawns the `gemini` CLI binary (from `@google/gemini-cli`).
 * The Gemini CLI does not support `--output-format stream-json`, so we
 * accumulate all stdout text and then emit Anvil Stream Format on completion
 * using the stream-format helpers.
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process';
import type {
  ModelAdapter,
  ModelAdapterConfig,
  ModelAdapterResult,
  ProviderCapabilities,
  ProviderName,
} from './types.js';
import { emitContent, emitResult } from './stream-format.js';

// ---------------------------------------------------------------------------
// Pricing table — [inputPer1M, outputPer1M]
// ---------------------------------------------------------------------------

const PRICING: Record<string, [number, number]> = {
  'gemini-2.5-pro': [1.25, 10.0],
  'gemini-2.5-flash': [0.30, 2.50],
  'gemini-2.5-flash-lite': [0.10, 0.40],
};

function pricingForModel(modelId: string): [number, number] {
  const lower = modelId.toLowerCase();
  for (const [key, pricing] of Object.entries(PRICING)) {
    if (lower.includes(key)) return pricing;
  }
  // Default to flash pricing
  return PRICING['gemini-2.5-flash'];
}

// ---------------------------------------------------------------------------
// Binary resolution
// ---------------------------------------------------------------------------

function resolveBinary(): string {
  return process.env.GEMINI_CLI_BIN ?? 'gemini';
}

// ---------------------------------------------------------------------------
// Token estimation — Gemini CLI doesn't report token counts, so we estimate
// from character count (roughly 4 chars per token for English text).
// ---------------------------------------------------------------------------

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class GeminiCliAdapter implements ModelAdapter {
  readonly provider: ProviderName = 'gemini-cli';

  readonly capabilities: ProviderCapabilities = {
    tier: 'agentic',
    streaming: true,
    toolUse: true,
    fileSystem: true,
    shellExecution: true,
    sessionResume: false,
  };

  private child: ChildProcess | null = null;

  supportsModel(_modelId: string): boolean {
    // Gemini CLI adapter is only used when explicitly configured as provider,
    // not for auto-detection by model name.
    return false;
  }

  getModelPricing(modelId: string): [number, number] | null {
    return pricingForModel(modelId);
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

    // ---- Build the prompt --------------------------------------------------
    // Project prompt is prepended to the user prompt since Gemini CLI doesn't
    // have a separate --project-prompt flag.
    const fullPrompt = config.projectPrompt
      ? `${config.projectPrompt}\n\n${config.userPrompt}`
      : config.userPrompt;

    // ---- Build args --------------------------------------------------------
    const args: string[] = [fullPrompt];

    // ---- Spawn -------------------------------------------------------------
    const child = spawn(bin, args, {
      cwd: config.workingDir,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    // End stdin immediately — prompt is passed via args
    child.stdin!.end();

    // Forward stderr to process.stderr
    child.stderr!.pipe(process.stderr);

    // ---- Accumulate stdout -------------------------------------------------
    const chunks: Buffer[] = [];
    child.stdout!.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });

    // ---- Wait for exit -----------------------------------------------------
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.on('close', (code) => resolve(code ?? 0));
      child.on('error', reject);
    });

    this.child = null;
    const durationMs = Date.now() - startTime;
    const fullText = Buffer.concat(chunks).toString('utf-8');

    if (exitCode !== 0 && !fullText.trim()) {
      throw new Error(`Gemini CLI exited with code ${exitCode}`);
    }

    // ---- Emit Anvil Stream Format ------------------------------------------
    const outputText = fullText.trim();

    // Estimate tokens from character count
    const inputTokens = estimateTokens(fullPrompt);
    const outputTokens = estimateTokens(outputText);

    const pricing = pricingForModel(config.model);
    const costUsd = (inputTokens * pricing[0] + outputTokens * pricing[1]) / 1_000_000;

    emitContent(output, outputText);
    emitResult(output, {
      text: outputText,
      costUsd,
      inputTokens,
      outputTokens,
      durationMs,
    });

    // ---- Build result ------------------------------------------------------
    return {
      output: outputText,
      inputTokens,
      outputTokens,
      costUsd,
      durationMs,
      provider: 'gemini-cli',
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
