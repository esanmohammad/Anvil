/**
 * Core ModelAdapter interface for multi-provider LLM support.
 *
 * Design decision: `run()` takes a `NodeJS.WritableStream` and writes NDJSON
 * lines in "Anvil Stream Format" — identical to Claude CLI's `stream-json`
 * output format. This means ALL existing parsers (run-feature.ts,
 * agent-process.ts, spawn.ts) work unchanged regardless of backend provider.
 */

export type ProviderName = 'claude' | 'openai' | 'gemini' | 'openrouter' | 'ollama' | 'gemini-cli' | 'adk';
export type ProviderTier = 'agentic' | 'function-calling' | 'text-only';

export interface ProviderCapabilities {
  tier: ProviderTier;
  streaming: boolean;
  toolUse: boolean;
  fileSystem: boolean;      // can read/write files directly
  shellExecution: boolean;  // can run commands
  sessionResume: boolean;   // can resume conversation
}

export interface ModelAdapterConfig {
  userPrompt: string;
  projectPrompt?: string;
  model: string;
  workingDir: string;
  stage: string;
  persona: string;
  sessionId?: string;
  resume?: boolean;
  permissionMode?: string;
  allowedTools?: string[];
  disallowedTools?: string[];
  timeout?: number;
}

export interface ModelAdapterResult {
  output: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  durationMs: number;
  sessionId?: string;
  provider: ProviderName;
  model: string;
}

export interface ModelAdapter {
  readonly provider: ProviderName;
  readonly capabilities: ProviderCapabilities;

  /** Check whether this adapter handles the given model identifier. */
  supportsModel(modelId: string): boolean;

  /** Return [inputPer1M, outputPer1M] pricing, or null if unknown. */
  getModelPricing(modelId: string): [number, number] | null;

  /** Verify the provider CLI / API is reachable and report its version. */
  checkAvailability(): Promise<{ available: boolean; version?: string; error?: string }>;

  /** Run agent. Write Anvil Stream Format NDJSON to `output`. */
  run(config: ModelAdapterConfig, output: NodeJS.WritableStream): Promise<ModelAdapterResult>;

  /** Kill running process if applicable. */
  kill?(): void;
}
