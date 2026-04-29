/**
 * Bridge — wraps an `@anvil/agent-core` `ModelAdapter` so it satisfies the
 * dashboard's `BaseAdapter` event-emit contract.
 *
 * The dashboard consumes adapters as stateful EventEmitters (`start()`,
 * `kill()`, plus `content` / `activity` / `result` / `error-output` / `exit`
 * events). agent-core's `ModelAdapter.run(config, output)` is a stateless
 * Promise-returning call that writes Anvil Stream Format NDJSON to the
 * supplied stream. The bridge converts between the two:
 *
 *   - `start()` kicks `run()` off against an in-process Writable that
 *     parses NDJSON lines and re-emits them as dashboard events.
 *   - The final `result` frame on the wire is ignored — the bridge waits
 *     for `run()` to resolve and emits `result` from the richer
 *     `ModelAdapterResult` (which includes `stopReason` / cache token
 *     counts that the wire format doesn't carry).
 *   - Errors raised by `run()` are surfaced as `error-output` + `exit(1)`.
 *
 * Capability mapping:
 *   - `agent-core/ProviderCapabilities.cache` → `AdapterCapabilities.promptCache`
 *   - `agent-core/ProviderCapabilities.cacheTtlSeconds` → same
 *   - `agent-core/ProviderCapabilities.maxOutputTokens` → same
 *   - `agent-core/ProviderCapabilities.structuredOutput` → same
 *
 * Phase 1 of the dashboard consolidation. See DASHBOARD-CONSOLIDATION-PLAN.md.
 */

import { Writable } from 'node:stream';
import type {
  ModelAdapter,
  ModelAdapterConfig,
  ModelAdapterResult,
  ProviderCapabilities,
  ProviderName,
} from '@anvil/agent-core';
import {
  BaseAdapter,
  type AdapterCapabilities,
  type AdapterConfig,
  type AdapterCostInfo,
} from './base-adapter.js';

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

// ── Tool-use summary (mirrors dashboard claude-adapter behavior) ─────────

function summarizeToolUse(name: string, input: Record<string, unknown>): string {
  switch (name) {
    case 'Read':
      return `Reading ${input.file_path ?? 'file'}`;
    case 'Edit':
      return `Editing ${input.file_path ?? 'file'}`;
    case 'Write':
      return `Writing ${input.file_path ?? 'file'}`;
    case 'Bash':
      return `Running: ${String(input.command ?? input.description ?? '').slice(0, 120)}`;
    case 'Grep':
      return `Searching for "${String(input.pattern ?? '').slice(0, 60)}"${input.path ? ` in ${input.path}` : ''}`;
    case 'Glob':
      return `Finding files: ${input.pattern ?? ''}`;
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

export class AgentCoreBridge extends BaseAdapter {
  private adapter: ModelAdapter;
  private providerName: ProviderName;
  private capabilitiesCache: AdapterCapabilities;
  private maxOutputTokens?: number;
  private isStarted = false;
  private isKilled = false;

  constructor(config: AdapterConfig, adapter: ModelAdapter, providerName: ProviderName) {
    super(config);
    this.adapter = adapter;
    this.providerName = providerName;
    this.capabilitiesCache = mapCapabilities(adapter.capabilities);
  }

  override get capabilities(): AdapterCapabilities {
    return this.capabilitiesCache;
  }

  override setMaxOutputTokens(n: number): void {
    if (n > 0) this.maxOutputTokens = n;
  }

  override markCacheBreakpoint(prompt: string, position: number): string {
    if (this.capabilitiesCache.promptCache !== 'explicit') return prompt;
    const safe = Math.max(0, Math.min(prompt.length, position));
    return prompt.slice(0, safe) + '\n<!-- anvil:cache-breakpoint -->\n' + prompt.slice(safe);
  }

  start(): void {
    if (this.isStarted) return;
    this.isStarted = true;
    void this.runAdapter();
  }

  kill(): void {
    this.isKilled = true;
    try {
      this.adapter.kill?.();
    } catch {
      // best-effort
    }
  }

  get pid(): number | undefined {
    return undefined;
  }

  get killed(): boolean {
    return this.isKilled;
  }

  // ── Internal ──────────────────────────────────────────────────────────

  private buildAdapterConfig(): ModelAdapterConfig {
    return {
      userPrompt: this.config.prompt,
      projectPrompt: this.config.projectPrompt,
      model: this.config.model,
      workingDir: this.config.cwd,
      // Stage / persona aren't part of the dashboard's AdapterConfig; the
      // ModelAdapters that need them (router-driven cli flows) receive
      // them from cli pathways instead. Pass empty strings here — adapter
      // implementations don't error on empty stage/persona.
      stage: '',
      persona: '',
      sessionId: this.config.sessionId,
      resume: this.config.resume,
      permissionMode: this.config.permissionMode,
      allowedTools: this.config.allowedTools,
      disallowedTools: this.config.disallowedTools,
      maxOutputTokens: this.maxOutputTokens,
    };
  }

  private async runAdapter(): Promise<void> {
    const sink = this.createStreamSink();
    let result: ModelAdapterResult | null = null;
    let runError: Error | null = null;

    try {
      result = await this.adapter.run(this.buildAdapterConfig(), sink);
    } catch (err) {
      runError = err instanceof Error ? err : new Error(String(err));
    }

    // Drain any buffered content the parser hasn't seen yet.
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
        sessionId: result.sessionId ?? this.config.sessionId,
      });
    }

    this.emit('exit', this.isKilled ? null : 0);
  }

  /**
   * Build a Writable that parses Anvil Stream Format NDJSON line-by-line
   * and re-emits dashboard events. The result frame is ignored here —
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

  private handleStreamLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let parsed: any;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return;
    }
    if (parsed?.type !== 'assistant' || !Array.isArray(parsed.message?.content)) return;

    for (const block of parsed.message.content as Array<Record<string, unknown>>) {
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
        this.emit('activity', {
          id: this.nextActivityId(),
          kind: 'tool_use',
          tool: block.name,
          summary: summarizeToolUse(block.name, input),
          content: JSON.stringify(input, null, 2),
          timestamp: Date.now(),
        });
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

  /** Provider name surfaced for diagnostics — not part of BaseAdapter contract. */
  get provider(): ProviderName {
    return this.providerName;
  }
}
