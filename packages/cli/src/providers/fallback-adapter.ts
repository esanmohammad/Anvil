/**
 * Fallback (chain) ModelAdapter.
 *
 * A meta-adapter that wraps an ordered list of adapters and tries them in
 * sequence. Each adapter is attempted up to `maxRetries + 1` times before the
 * next adapter in the chain is tried. If every adapter is exhausted the
 * combined error is thrown.
 */

import type {
  ModelAdapter,
  ModelAdapterConfig,
  ModelAdapterResult,
  ProviderCapabilities,
  ProviderName,
} from './types.js';
import { emitContent } from './stream-format.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class FallbackAdapter implements ModelAdapter {
  private chain: ModelAdapter[];
  private maxRetries: number;
  private retryDelayMs: number;

  constructor(
    chain: ModelAdapter[],
    maxRetries: number = 1,
    retryDelayMs: number = 2000,
  ) {
    if (chain.length === 0) {
      throw new Error('FallbackAdapter requires at least one adapter in the chain');
    }
    this.chain = chain;
    this.maxRetries = maxRetries;
    this.retryDelayMs = retryDelayMs;
  }

  get provider(): ProviderName {
    return this.chain[0].provider;
  }

  get capabilities(): ProviderCapabilities {
    return this.chain[0].capabilities;
  }

  supportsModel(modelId: string): boolean {
    return this.chain.some((adapter) => adapter.supportsModel(modelId));
  }

  getModelPricing(modelId: string): [number, number] | null {
    for (const adapter of this.chain) {
      const pricing = adapter.getModelPricing(modelId);
      if (pricing !== null) return pricing;
    }
    return null;
  }

  async checkAvailability(): Promise<{ available: boolean; version?: string; error?: string }> {
    const errors: string[] = [];
    for (const adapter of this.chain) {
      const result = await adapter.checkAvailability();
      if (result.available) return result;
      if (result.error) errors.push(`${adapter.provider}: ${result.error}`);
    }
    return { available: false, error: errors.join('; ') };
  }

  async run(config: ModelAdapterConfig, output: NodeJS.WritableStream): Promise<ModelAdapterResult> {
    const errors: string[] = [];

    for (const adapter of this.chain) {
      const maxAttempts = this.maxRetries + 1;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          return await adapter.run(config, output);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          errors.push(`${adapter.provider}[attempt ${attempt + 1}]: ${message}`);

          const isLastAttemptForAdapter = attempt === maxAttempts - 1;
          const isLastAdapter = adapter === this.chain[this.chain.length - 1];

          if (isLastAttemptForAdapter && !isLastAdapter) {
            emitContent(
              output,
              `[Anvil] Provider ${adapter.provider} failed (${message}), trying next...`,
            );
          } else if (!isLastAttemptForAdapter) {
            // Retry the same adapter after a delay
            await delay(this.retryDelayMs);
          }
        }
      }
    }

    throw new Error(
      `All providers in the fallback chain failed:\n${errors.map((e) => `  - ${e}`).join('\n')}`,
    );
  }

  kill(): void {
    for (const adapter of this.chain) {
      if (adapter.kill) {
        adapter.kill();
      }
    }
  }
}
