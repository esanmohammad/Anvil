/**
 * `LanguageModelBridge` — adapts an `@anvil/agent-core` `ModelAdapter` (or a
 * future `LanguageModel`) to the `AgentAdapter` interface that
 * `AgentProcess` consumes (5-event EventEmitter: `content` / `activity` /
 * `result` / `error-output` / `exit`).
 *
 * Two surfaces in one class:
 *   - `AgentAdapter` (lifecycle): `start()` / `kill()` + the 5 events.
 *     This is what `AgentProcess` drives.
 *   - Prompt-construction helpers: `capabilities` (with `promptCache`
 *     stance), `markCacheBreakpoint(prompt, position)`, `countTokens(text)`.
 *     These let prompt-envelope code make caching decisions before the
 *     spawn — out of band of the lifecycle.
 *
 * Behavior:
 *   - `start()` kicks `ModelAdapter.run()` against an in-process Writable
 *     that parses Anvil Stream Format NDJSON and re-emits dashboard events.
 *   - The wire-format `result` frame is ignored — the bridge waits for
 *     `run()` to resolve and emits `result` from the richer
 *     `ModelAdapterResult` (which includes `stopReason` + cache token
 *     counts that the wire format doesn't carry).
 *   - Errors from `run()` surface as `error-output` + `exit(1)`.
 */

import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { SpanStatusCode, type Span } from '@opentelemetry/api';
import type {
  ModelAdapter,
  ModelAdapterConfig,
  ModelAdapterResult,
  ProviderCapabilities,
  ProviderName,
  ToolExecutorLike,
} from '../../types.js';
import type { AdapterRequest, AgentAdapter } from './adapter.js';
import type {
  AdapterCapabilities,
  AdapterCostInfo,
} from './legacy-adapter-types.js';
import { instrumentModelAdapter } from '../../telemetry/instrument.js';
import { getTracer } from '../../telemetry/tracer.js';
import { BuiltinToolExecutor } from '../../tools/index.js';
import { loadModelRegistry } from '../../router/model-registry.js';

// ── Capability mapping ───────────────────────────────────────────────────

const STRUCTURED_OUTPUT_DEFAULT = 'best-effort' as const;

function mapCapabilities(caps: ProviderCapabilities): AdapterCapabilities {
  const promptCache: AdapterCapabilities['promptCache'] =
    caps.cache ?? (caps.promptCaching ? 'auto' : 'none');
  return {
    promptCache,
    countTokens: 'heuristic',
    structuredOutput: caps.structuredOutput ?? STRUCTURED_OUTPUT_DEFAULT,
    cacheTtlSeconds: caps.cacheTtlSeconds,
    maxOutputTokens: caps.maxOutputTokens === true,
  };
}

// ── Tool-use summary ─────────────────────────────────────────────────────

function summarizeToolUse(name: string, input: Record<string, unknown>): string {
  // Two casings live in this stream simultaneously: Claude CLI ships
  // PascalCase tool names (Read/Edit/Write/Bash/Grep/Glob), and the
  // BuiltinToolExecutor (used by Ollama / OpenCode / OpenRouter
  // agentic adapters) emits snake_case (read_file/edit/write_file/
  // bash/grep/glob/list). Field shapes also differ on the path arg —
  // Claude uses `file_path`, Builtin uses `path`. Normalize so the
  // dashboard activity log shows the same human label regardless.
  const path = (input.file_path ?? input.path ?? 'file') as string;
  switch (name) {
    case 'Read':
    case 'read_file':
      return `Reading ${path}`;
    case 'Edit':
    case 'edit':
      return `Editing ${path}`;
    case 'Write':
    case 'write_file':
      return `Writing ${path}`;
    case 'Bash':
    case 'bash':
      return `Running: ${String(input.command ?? input.description ?? '').slice(0, 120)}`;
    case 'Grep':
    case 'grep':
      return `Searching for "${String(input.pattern ?? '').slice(0, 60)}"${input.path ? ` in ${input.path}` : ''}`;
    case 'Glob':
    case 'glob':
      return `Finding files: ${input.pattern ?? ''}`;
    case 'list':
      return `Listing ${input.path ?? '.'}`;
    case 'Agent':
      return `Spawning sub-agent: ${input.description ?? ''}`;
    case 'Skill':
      return `Using skill: ${input.skill ?? ''}${input.args ? ` ${input.args}` : ''}`;
    case 'ToolSearch':
      return `Searching tools: ${input.query ?? ''}`;
    case 'TaskCreate':
      return `Creating task: ${input.description ?? ''}`;
    case 'TaskUpdate':
      return `Updating task: ${input.id ?? ''} → ${input.status ?? ''}`;
    default:
      return `Using ${name}`;
  }
}

// ── Bridge ───────────────────────────────────────────────────────────────

export class LanguageModelBridge extends EventEmitter implements AgentAdapter {
  private readonly request: AdapterRequest;
  private readonly adapter: ModelAdapter;
  private readonly providerName: ProviderName;
  private readonly capabilitiesCache: AdapterCapabilities;
  private maxOutputTokensOverride?: number;
  private isStarted = false;
  private isKilled = false;
  private activityCounter = 0;
  /** Map of tool_use_id → open child span. Tool spans are opened when we
   *  see a `tool_use` block in the assistant stream and closed when the
   *  matching `tool_result` arrives in a user-role message. Surviving
   *  entries on adapter end are closed with status=UNSET so they're still
   *  visible — adapters that hang up before tool_result arrives are not
   *  uncommon. */
  private readonly openToolSpans = new Map<string, Span>();

  constructor(
    request: AdapterRequest,
    adapter: ModelAdapter,
    providerName: ProviderName,
  ) {
    super();
    this.request = request;
    // Wrap the adapter so every `run()` emits an OTel `gen_ai.invoke` span.
    // No-op when telemetry is disabled (loadTelemetryConfig returns the
    // noop exporter and OTel's no-op tracer skips work).
    this.adapter = instrumentModelAdapter(adapter);
    this.providerName = providerName;
    this.capabilitiesCache = mapCapabilities(adapter.capabilities);
  }

  // ── AgentAdapter surface ─────────────────────────────────────────────

  start(): void {
    if (this.isStarted) return;
    this.isStarted = true;
    void this.runAdapter();
  }

  kill(_signal?: string): void {
    this.isKilled = true;
    try {
      this.adapter.kill?.();
    } catch {
      // best-effort
    }
  }

  setMaxOutputTokens(n: number): void {
    if (n > 0) this.maxOutputTokensOverride = n;
  }

  get pid(): number | undefined {
    return undefined;
  }

  get killed(): boolean {
    return this.isKilled;
  }

  // ── Prompt-construction surface ───────────────────────────────────────

  get capabilities(): AdapterCapabilities {
    return this.capabilitiesCache;
  }

  /** Heuristic estimator (chars / 4). Concrete adapters with exact token
   *  counters can override; bridges use the heuristic. */
  countTokens(text: string): number {
    if (!text) return 0;
    return Math.ceil(text.length / 4);
  }

  /** Insert a cache breakpoint marker into `prompt` at byte `position`.
   *  No-op for `auto` / `none` providers. */
  markCacheBreakpoint(prompt: string, position: number): string {
    if (this.capabilitiesCache.promptCache !== 'explicit') return prompt;
    const safe = Math.max(0, Math.min(prompt.length, position));
    return prompt.slice(0, safe) + '\n<!-- anvil:cache-breakpoint -->\n' + prompt.slice(safe);
  }

  /** Provider name surfaced for diagnostics. */
  get provider(): ProviderName {
    return this.providerName;
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private buildAdapterConfig(): ModelAdapterConfig {
    const config: ModelAdapterConfig = {
      userPrompt: this.request.prompt,
      projectPrompt: this.request.projectPrompt,
      model: this.request.model,
      workingDir: this.request.cwd,
      stage: this.request.stage ?? '',
      persona: this.request.persona ?? '',
      sessionId: this.request.sessionId,
      resume: this.request.resume,
      permissionMode: this.request.permissionMode,
      allowedTools: this.request.allowedTools,
      disallowedTools: this.request.disallowedTools,
      maxOutputTokens: this.maxOutputTokensOverride ?? this.request.maxOutputTokens,
    };

    // Non-Claude providers need a tool executor + bounded context to drive
    // an agentic loop. Claude CLI ships its own tool runtime; passing one
    // here would be ignored. Keep the construction lazy so this method
    // stays cheap when called by adapters that don't loop.
    if (this.providerName !== 'claude') {
      const executor = buildBuiltinExecutor(this.request);
      if (executor) config.toolExecutor = executor;
      const ctx = lookupContextWindow(this.request.model);
      if (ctx !== undefined) config.contextWindow = ctx;
    }

    if (this.request.exclusiveSlot) {
      config.exclusiveSlot = true;
    }

    return config;
  }

  private async runAdapter(): Promise<void> {
    const sink = this.createStreamSink();
    let result: ModelAdapterResult | null = null;
    let runError: Error | null = null;

    try {
      result = await this.adapter.run(this.buildAdapterConfig(), sink);
    } catch (err) {
      runError = err instanceof Error ? err : new Error(String(err));
    } finally {
      // Close any tool spans whose tool_result never arrived (e.g. adapter
      // crashed mid-call). Must happen BEFORE the adapter run span ends
      // so OTel captures them as siblings, not orphans.
      this.closeOpenToolSpans();
    }

    sink.end();

    if (runError) {
      if (!this.isKilled) {
        this.emit('error-output', runError.message);
      }
      this.emit('exit', 1);
      return;
    }

    if (result) {
      const cost: AdapterCostInfo = {
        totalUsd: result.costUsd ?? 0,
        inputTokens: result.inputTokens ?? 0,
        outputTokens: result.outputTokens ?? 0,
        cacheReadTokens: result.cacheReadTokens ?? 0,
        cacheWriteTokens: result.cacheWriteTokens ?? 0,
        durationMs: result.durationMs ?? 0,
        stopReason: result.stopReason,
      };
      this.emit('result', {
        result: result.output ?? '',
        cost,
        sessionId: result.sessionId ?? this.request.sessionId,
      });
    }

    this.emit('exit', this.isKilled ? null : 0);
  }

  /**
   * Build a Writable that parses Anvil Stream Format NDJSON line-by-line
   * and re-emits AgentAdapter events. The result frame is ignored here —
   * the bridge surfaces it from the resolved ModelAdapterResult instead.
   */
  private createStreamSink(): Writable {
    let buffer = '';
    return new Writable({
      write: (chunk, _enc, cb) => {
        buffer += chunk.toString('utf-8');
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) this.handleStreamLine(line);
        cb();
      },
      final: (cb) => {
        if (buffer) {
          this.handleStreamLine(buffer);
          buffer = '';
        }
        cb();
      },
    });
  }

  private nextActivityId(): string {
    return `act-${this.request.sessionId.slice(0, 8)}-${++this.activityCounter}`;
  }

  private handleStreamLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: { type?: string; message?: { content?: Array<Record<string, unknown>> } };
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }

    // Tool-use blocks come in `assistant` messages. The corresponding
    // `tool_result` blocks come back in `user` messages. We pair them up
    // by `tool_use_id` to materialise child spans.
    if (parsed?.type === 'assistant' && Array.isArray(parsed.message?.content)) {
      this.handleAssistantBlocks(parsed.message.content);
      return;
    }
    if (parsed?.type === 'user' && Array.isArray(parsed.message?.content)) {
      this.handleUserBlocks(parsed.message.content);
      return;
    }
  }

  private handleAssistantBlocks(blocks: Array<Record<string, unknown>>): void {
    for (const block of blocks) {
      if (block.type === 'text' && typeof block.text === 'string') {
        this.emit('content', block.text);
        this.emit('activity', {
          id: this.nextActivityId(),
          kind: 'text',
          summary: block.text.slice(0, 200),
          content: block.text,
          timestamp: Date.now(),
        });
      } else if (block.type === 'tool_use' && typeof block.name === 'string') {
        const input = (block.input as Record<string, unknown>) ?? {};
        const toolUseId = typeof block.id === 'string' ? block.id : undefined;
        this.emit('activity', {
          id: this.nextActivityId(),
          kind: 'tool_use',
          tool: block.name,
          summary: summarizeToolUse(block.name, input),
          content: JSON.stringify(input, null, 2),
          timestamp: Date.now(),
        });
        this.openToolSpan(block.name, input, toolUseId);
      } else if (block.type === 'thinking' && typeof block.text === 'string') {
        this.emit('activity', {
          id: this.nextActivityId(),
          kind: 'thinking',
          summary: block.text.slice(0, 200),
          content: block.text,
          timestamp: Date.now(),
        });
      }
    }
  }

  private handleUserBlocks(blocks: Array<Record<string, unknown>>): void {
    for (const block of blocks) {
      if (block.type !== 'tool_result') continue;
      const toolUseId = typeof block.tool_use_id === 'string' ? block.tool_use_id : undefined;
      if (!toolUseId) continue;
      const isError = block.is_error === true;
      this.closeToolSpan(toolUseId, { isError });
    }
  }

  /** Open a child span for a tool_use block. The span lives in the active
   *  `gen_ai.invoke` span's context — that's set up by instrumentModelAdapter
   *  before adapter.run() starts streaming. We rely on Node's
   *  AsyncLocalStorage to propagate context through the Writable callback. */
  private openToolSpan(
    name: string,
    input: Record<string, unknown>,
    toolUseId: string | undefined,
  ): void {
    if (!toolUseId) return; // Without an id we can't pair the result; skip.
    const tracer = getTracer();
    const span = tracer.startSpan(`gen_ai.tool.${name}`, {
      attributes: {
        'gen_ai.tool.name': name,
        'gen_ai.tool.call.id': toolUseId,
        'gen_ai.tool.input.summary': summarizeToolUse(name, input).slice(0, 256),
      },
    });
    this.openToolSpans.set(toolUseId, span);
  }

  /** Close a tool span when its matching tool_result arrives. */
  private closeToolSpan(toolUseId: string, result: { isError: boolean }): void {
    const span = this.openToolSpans.get(toolUseId);
    if (!span) return;
    this.openToolSpans.delete(toolUseId);
    if (result.isError) {
      span.setStatus({ code: SpanStatusCode.ERROR });
    } else {
      span.setStatus({ code: SpanStatusCode.OK });
    }
    span.end();
  }

  /** Close any tool spans that never received a tool_result. Called from
   *  runAdapter's finally block so abandoned spans don't linger. */
  private closeOpenToolSpans(): void {
    for (const span of this.openToolSpans.values()) {
      span.setAttribute('gen_ai.tool.abandoned', true);
      span.end();
    }
    this.openToolSpans.clear();
  }
}

// ───────────────────────────────────────────────────────────────────────
// Helpers — tool executor + context window lookup for non-Claude paths
// ───────────────────────────────────────────────────────────────────────

/**
 * Build a `BuiltinToolExecutor` for an agentic non-Claude run. The
 * `request.allowedTools` field carries the per-stage permission set
 * the dashboard pipeline-runner populated upstream. When it's missing
 * (legacy spawn sites that haven't been upgraded yet), we conservatively
 * fall back to read-only tools so the model can still work but never
 * mutates the workspace.
 */
function buildBuiltinExecutor(req: AdapterRequest): ToolExecutorLike | undefined {
  if (!req.cwd) return undefined;
  const allowed = req.allowedTools && req.allowedTools.length > 0
    ? req.allowedTools
    : ['read_file', 'grep', 'glob', 'list'];
  return new BuiltinToolExecutor({ allowedTools: allowed });
}

/**
 * Look up the configured `context_window` for a model in the registry.
 * Returns undefined when the model isn't in the registry or has no
 * context_window set — the adapter then falls back to its own default.
 *
 * Cached lazily; the registry file rarely changes during a run.
 */
let _registryCache: Map<string, number> | null = null;

function lookupContextWindow(modelId: string): number | undefined {
  if (!_registryCache) {
    _registryCache = new Map<string, number>();
    try {
      const reg = loadModelRegistry();
      for (const m of reg.models) {
        if (m.context_window !== undefined) {
          _registryCache.set(m.id, m.context_window);
        }
      }
    } catch {
      // Registry missing/invalid → no context-window data; adapters use defaults.
    }
  }
  return _registryCache.get(modelId);
}

/** Test/internal — reset the registry cache so the next lookup re-reads. */
export function _resetBridgeRegistryCache(): void {
  _registryCache = null;
}
