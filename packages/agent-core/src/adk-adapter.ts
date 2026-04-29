/**
 * Google Agent Development Kit (ADK) ModelAdapter.
 *
 * ADK is a TypeScript agent framework built on top of Gemini. This adapter
 * wraps it to expose the standard ModelAdapter interface. Since ADK is an
 * optional peer dependency, the adapter gracefully degrades when the package
 * is not installed — falling back to the Gemini CLI adapter for actual
 * execution while logging a warning.
 */

import type {
  ModelAdapter,
  ModelAdapterConfig,
  ModelAdapterResult,
  ProviderCapabilities,
  ProviderName,
} from './types.js';
import { emitContent } from './stream-format.js';
import { GeminiCliAdapter } from './gemini-cli-adapter.js';

// ---------------------------------------------------------------------------
// ADK availability detection
// ---------------------------------------------------------------------------

let adkAvailable: boolean | null = null;

async function probeAdk(): Promise<boolean> {
  if (adkAvailable !== null) return adkAvailable;
  try {
    // Dynamic import — @google/adk is an optional peer dependency.
    // Use a variable to prevent TypeScript from resolving the module at compile time.
    const pkg = '@google/adk';
    await import(pkg);
    adkAvailable = true;
  } catch {
    adkAvailable = false;
  }
  return adkAvailable;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export class AdkAdapter implements ModelAdapter {
  readonly provider: ProviderName = 'adk';

  // NOTE: ADK adapter currently delegates to Gemini CLI. Full ADK integration
  // requires @google/adk package and will be implemented when the TS SDK stabilizes.
  // Capabilities reflect the Gemini CLI fallback, not full ADK potential.
  readonly capabilities: ProviderCapabilities = {
    tier: 'agentic',
    streaming: true,
    toolUse: true,
    fileSystem: true,
    shellExecution: true,
    sessionResume: false,
  };

  private geminiAdapter: GeminiCliAdapter;
  private adkImported: boolean | null = null;

  constructor() {
    this.geminiAdapter = new GeminiCliAdapter();

    // Kick off the async probe so the result is cached for later calls.
    void probeAdk().then((available) => {
      this.adkImported = available;
    });
  }

  supportsModel(_modelId: string): boolean {
    // ADK adapter is only used when explicitly configured as provider='adk',
    // not for auto-detection by model name.
    return false;
  }

  getModelPricing(modelId: string): [number, number] | null {
    // ADK uses Gemini models under the hood — pricing is identical.
    return this.geminiAdapter.getModelPricing(modelId);
  }

  async checkAvailability(): Promise<{ available: boolean; version?: string; error?: string }> {
    const hasAdk = await probeAdk();
    if (!hasAdk) {
      return {
        available: false,
        error: 'Install @google/adk: npm install @google/adk',
      };
    }

    // ADK is importable — also verify the underlying Gemini CLI is reachable
    // since we delegate execution to it in the current stub implementation.
    const geminiCheck = await this.geminiAdapter.checkAvailability();
    if (geminiCheck.available) {
      return { available: true, version: `adk (gemini-cli ${geminiCheck.version ?? 'unknown'})` };
    }
    return geminiCheck;
  }

  async run(config: ModelAdapterConfig, output: NodeJS.WritableStream): Promise<ModelAdapterResult> {
    const hasAdk = await probeAdk();

    if (!hasAdk) {
      throw new Error(
        '@google/adk is not installed. Install it with: npm install @google/adk',
      );
    }

    // -----------------------------------------------------------------------
    // STUB: Full ADK agent integration requires mapping ADK's agent/tool/
    // event APIs, which depend on the @google/adk API surface that may evolve.
    // For now we fall back to the Gemini CLI adapter (ADK is Gemini-native)
    // and emit a warning so callers know the full ADK pipeline isn't active.
    // -----------------------------------------------------------------------
    emitContent(
      output,
      '[Anvil] Warning: Full ADK agent integration is not yet implemented. ' +
        'Falling back to Gemini CLI for execution. Install @google/adk for ' +
        'future native agent support.',
    );

    const result = await this.geminiAdapter.run(config, output);

    // Re-tag the result so callers see the 'adk' provider label.
    return {
      ...result,
      provider: 'adk',
    };
  }

  kill(): void {
    this.geminiAdapter.kill();
  }
}
