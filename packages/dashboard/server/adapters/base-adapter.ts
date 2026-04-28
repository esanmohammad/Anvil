/**
 * Base adapter interface for all AI provider adapters.
 *
 * Every adapter emits the same events so AgentProcess can delegate
 * transparently regardless of provider.
 */

import { EventEmitter } from 'node:events';

export interface AdapterConfig {
  prompt: string;
  model: string;
  sessionId: string;
  cwd: string;
  resume?: boolean;
  projectPrompt?: string;
  permissionMode?: string;
  disallowedTools?: string[];
  allowedTools?: string[];
}

/**
 * Provider-agnostic capability descriptor.
 *
 * Token-optimization machinery (prompt envelope, output ceiling, structured
 * extraction) routes through these flags so caller code stays portable
 * across Claude / OpenAI-shape / Gemini / Ollama backends.
 */
export interface AdapterCapabilities {
  /**
   * - 'auto'     — provider caches stable prefixes silently (e.g., OpenAI ≥1024 tok).
   * - 'explicit' — caller must place markers (e.g., Anthropic cache_control).
   * - 'none'     — no caching benefit; markers are no-ops.
   */
  promptCache: 'auto' | 'explicit' | 'none';
  /** Whether countTokens uses the model's exact tokenizer or an estimator. */
  countTokens: 'exact' | 'heuristic';
  /** Structured-output support level. */
  structuredOutput: 'strict' | 'tool-shim' | 'best-effort' | 'none';
  /** Cache TTL in seconds when promptCache !== 'none'. Informational only. */
  cacheTtlSeconds?: number;
  /** Adapter knows how to enforce a max-output ceiling. */
  maxOutputTokens: boolean;
}

export interface AdapterCostInfo {
  totalUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  durationMs: number;
  /**
   * Phase 3 — provider's stop reason for the call. Common values:
   *   - 'end_turn' / 'stop'        — natural completion
   *   - 'max_tokens' / 'length'    — output ceiling hit (TRUNCATION)
   *   - 'tool_use'                 — agent paused for a tool call
   *
   * Optional: heuristic adapters that don't expose a reason leave it undefined.
   */
  stopReason?: string;
}

export interface AdapterActivity {
  id: string;
  kind: 'tool_use' | 'thinking' | 'text';
  tool?: string;
  summary: string;
  content?: string;
  timestamp: number;
}

export interface AdapterEvents {
  content: (text: string) => void;
  activity: (activity: AdapterActivity) => void;
  result: (data: { result: string; cost: AdapterCostInfo; sessionId: string }) => void;
  'error-output': (text: string) => void;
  exit: (code: number | null) => void;
}

/** Default capabilities used when a concrete adapter does not override. */
const DEFAULT_CAPABILITIES: AdapterCapabilities = {
  promptCache: 'none',
  countTokens: 'heuristic',
  structuredOutput: 'best-effort',
  maxOutputTokens: false,
};

export abstract class BaseAdapter extends EventEmitter {
  protected config: AdapterConfig;
  protected activityCounter = 0;

  constructor(config: AdapterConfig) {
    super();
    this.config = config;
  }

  abstract start(): void;
  abstract kill(): void;
  abstract get pid(): number | undefined;
  abstract get killed(): boolean;

  /**
   * Provider capabilities. Concrete adapters SHOULD override; the default
   * is conservative ("does nothing fancy") so unknown providers stay safe.
   */
  get capabilities(): AdapterCapabilities {
    return DEFAULT_CAPABILITIES;
  }

  /**
   * Estimate token count for a string under this adapter's model.
   *
   * The default is the chars/4 heuristic, accurate within ~10% for English
   * text and code. Concrete adapters SHOULD override with the provider's
   * real tokenizer when one is available (set capabilities.countTokens to
   * 'exact' once they do).
   */
  countTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  /**
   * Insert a cache breakpoint marker into `prompt` at byte `position`.
   *
   * - For 'explicit' providers (Anthropic): subclasses transform the prompt
   *   to embed the provider-native marker.
   * - For 'auto' / 'none' providers: default impl returns prompt unchanged
   *   (the cache fires off byte-stable prefixes regardless of markers).
   *
   * Returns the (possibly transformed) full prompt string.
   */
  markCacheBreakpoint(prompt: string, _position: number): string {
    return prompt;
  }

  /**
   * Set a max-output-tokens ceiling for the next call. No-op when the
   * underlying provider doesn't expose a max-tokens knob.
   */
  setMaxOutputTokens(_n: number): void {
    /* no-op */
  }

  protected nextActivityId(): string {
    return `act-${this.config.sessionId.slice(0, 8)}-${++this.activityCounter}`;
  }

  protected zeroCost(): AdapterCostInfo {
    return {
      totalUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      durationMs: 0,
      stopReason: undefined,
    };
  }

  // Typed emit helpers
  override emit<K extends keyof AdapterEvents>(
    event: K,
    ...args: Parameters<AdapterEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  override on<K extends keyof AdapterEvents>(
    event: K,
    listener: AdapterEvents[K],
  ): this {
    return super.on(event, listener);
  }
}
