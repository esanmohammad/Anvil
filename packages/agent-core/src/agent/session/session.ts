/**
 * `AgentProcess` — one logical agent.
 *
 * Owns the spawn → resume → resume → done lifecycle for a single agent. Pipes
 * adapter events through to its own EventEmitter surface so consumers (the
 * dashboard's WebSocket layer; cli's await-result loop) wire once and
 * survive multiple resume calls.
 */

import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';
import {
  context as otelContext,
  trace,
  SpanStatusCode,
  type Context,
  type Span,
} from '@opentelemetry/api';
import type {
  AdapterRequest,
  AgentAdapter,
  AgentAdapterFactory,
} from './adapter.js';
import { buildAdapterRequest } from './adapter.js';
import { getTracer } from '../../telemetry/tracer.js';
import type {
  AgentActivity,
  AgentProcessEvents,
  AgentState,
  AgentStatus,
  CostInfo,
  SpawnConfig,
} from './types.js';

// ── Tunables ────────────────────────────────────────────────────────────

/** Cap in-memory output to 500KB, keeping the tail. */
const MAX_OUTPUT_BYTES = 500 * 1024;
/** Cap in-memory activities to 500 entries. */
const MAX_ACTIVITIES = 500;
/** Grace window after a 0-exit before treating the session as failed-empty. */
const POST_EXIT_GRACE_MS = 500;
/** "Empty exit" detector window — runs shorter than this with no output → error. */
const EMPTY_EXIT_THRESHOLD_MS = 5000;

// ── Public ──────────────────────────────────────────────────────────────

export interface AgentProcessOpts {
  /** Override the generated id. Defaults to a UUID v4. */
  id?: string;
  /** Adapter factory — required. */
  adapterFactory: AgentAdapterFactory;
  /** Test seam — clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Test seam — `setTimeout` substitute. */
  setTimeoutImpl?: (fn: () => void, ms: number) => void;
}

export class AgentProcess extends EventEmitter {
  readonly id: string;
  readonly spec: SpawnConfig;
  readonly sessionId: string;
  protected adapter: AgentAdapter | null = null;
  protected state: AgentState;
  protected readonly factory: AgentAdapterFactory;
  protected readonly now: () => number;
  protected readonly setTimeoutImpl: (fn: () => void, ms: number) => void;
  /** Parent span covering the agent's whole lifetime — initial run +
   *  every resume. Each adapter.run() span becomes a child via
   *  AsyncLocalStorage propagation when start()/sendInput run inside
   *  `sessionContext`. */
  private sessionSpan: Span | null = null;
  private sessionContext: Context | null = null;
  private sessionEnded = false;

  constructor(spec: SpawnConfig, opts: AgentProcessOpts) {
    super();
    this.spec = spec;
    this.factory = opts.adapterFactory;
    this.now = opts.now ?? Date.now;
    this.setTimeoutImpl = opts.setTimeoutImpl ?? ((fn, ms) => { setTimeout(fn, ms); });
    this.sessionId = opts.id ?? generateSessionId();
    this.id = this.sessionId;
    this.state = createPendingState(spec, this.id);
  }

  // ── Typed event helpers ──────────────────────────────────────────────

  override on<K extends keyof AgentProcessEvents>(
    event: K,
    listener: AgentProcessEvents[K],
  ): this {
    return super.on(event, listener);
  }

  override emit<K extends keyof AgentProcessEvents>(
    event: K,
    ...args: Parameters<AgentProcessEvents[K]>
  ): boolean {
    return super.emit(event, ...args);
  }

  // ── Lifecycle ────────────────────────────────────────────────────────

  /** Start the process. Spawns the underlying adapter and begins streaming. */
  start(): void {
    this.openSessionSpan();
    const req = buildAdapterRequest(this.spec, this.sessionId);
    const adapter = this.factory(req);
    if (
      typeof this.spec.maxOutputTokens === 'number'
      && this.spec.maxOutputTokens > 0
      && typeof adapter.setMaxOutputTokens === 'function'
    ) {
      adapter.setMaxOutputTokens(this.spec.maxOutputTokens);
    }
    this.adapter = adapter;
    this.wireAdapter(adapter);
    // Run the adapter inside the session-span's context so every
    // adapter.run() span becomes a child of the session.
    this.runWithSessionContext(() => adapter.start());
    this.state.status = 'running';
    this.state.startedAt = this.now();
  }

  /**
   * Send input to a running process — spawns a NEW adapter with `resume:
   * true` and the same `sessionId`, re-wires events through this process.
   */
  sendInput(text: string): void {
    // Show user message in output stream
    const userChunk = `\n\n> User: ${text}\n\n`;
    appendOutput(this.state, userChunk);
    this.emit('content', userChunk);

    // Update agent status back to running
    this.state.status = 'running';
    this.state.finishedAt = null;

    const req: AdapterRequest = buildAdapterRequest(
      { ...this.spec, prompt: text },
      this.sessionId,
      // No cwdOverride — Claude's session storage is keyed by cwd, so a
      // resume MUST use the same working directory as the original spawn.
      // Forcing process.cwd() here breaks `claude --resume <id>` with
      // "No conversation found" whenever the dashboard's cwd differs
      // from the project workspace it spawned the agent in.
      { resume: true },
    );
    const resumeAdapter = this.factory(req);
    if (
      typeof this.spec.maxOutputTokens === 'number'
      && this.spec.maxOutputTokens > 0
      && typeof resumeAdapter.setMaxOutputTokens === 'function'
    ) {
      resumeAdapter.setMaxOutputTokens(this.spec.maxOutputTokens);
    }
    this.adapter = resumeAdapter;
    this.wireAdapter(resumeAdapter);
    // Resume runs inside the same session span as the initial start —
    // both adapter calls are children of one trace, so a multi-turn
    // session shows up as a single waterfall.
    this.runWithSessionContext(() => resumeAdapter.start());
  }

  /** Kill the underlying adapter and mark the process as `killed`. */
  kill(signal?: NodeJS.Signals): void {
    if (this.adapter) {
      try {
        this.adapter.kill(signal);
      } catch { /* already dead */ }
    }
    this.state.status = 'killed';
    this.state.finishedAt = this.now();
    this.closeSessionSpan('killed');
  }

  // ── State queries ────────────────────────────────────────────────────

  /** Read-only snapshot of the process's runtime state. */
  getState(): AgentState {
    return this.state;
  }

  get status(): AgentStatus {
    return this.state.status;
  }

  get cost(): CostInfo {
    return this.state.cost;
  }

  get activities(): AgentActivity[] {
    return this.state.activities;
  }

  get output(): string {
    return this.state.output;
  }

  // ── Internals ────────────────────────────────────────────────────────

  /** Open a `anvil.agent.session` span scoped to this AgentProcess. Idempotent
   *  — once opened, lives until kill() / done / error. */
  private openSessionSpan(): void {
    if (this.sessionSpan) return;
    const tracer = getTracer();
    this.sessionSpan = tracer.startSpan('anvil.agent.session', {
      attributes: {
        'anvil.agent.id': this.id,
        'anvil.agent.name': this.spec.name,
        'anvil.persona': this.spec.persona,
        'anvil.project': this.spec.project,
        'anvil.stage': this.spec.stage,
        'anvil.session.session_id': this.sessionId,
        'anvil.run.id': this.spec.runId ?? '',
        'gen_ai.system': 'anvil',
        'gen_ai.request.model': this.spec.model,
      },
    });
    this.sessionContext = trace.setSpan(otelContext.active(), this.sessionSpan);
  }

  /** End the session span exactly once. Idempotent. */
  private closeSessionSpan(outcome: 'done' | 'killed' | 'error'): void {
    if (this.sessionEnded || !this.sessionSpan) return;
    this.sessionEnded = true;
    this.sessionSpan.setAttribute('anvil.agent.outcome', outcome);
    if (outcome === 'error' || outcome === 'killed') {
      this.sessionSpan.setStatus({
        code: SpanStatusCode.ERROR,
        message: outcome === 'killed' ? 'agent killed' : 'agent errored',
      });
    } else {
      this.sessionSpan.setStatus({ code: SpanStatusCode.OK });
    }
    this.sessionSpan.end();
    this.sessionSpan = null;
    this.sessionContext = null;
  }

  /** Run a callback inside the session span's context. Adapter calls made
   *  inside this run with active context propagated via AsyncLocalStorage,
   *  so every gen_ai.invoke + tool span lands as a child of the session. */
  private runWithSessionContext<T>(fn: () => T): T {
    if (!this.sessionContext) return fn();
    return otelContext.with(this.sessionContext, fn);
  }

  protected wireAdapter(adapter: AgentAdapter): void {
    adapter.on('content', (chunk: string) => {
      appendOutput(this.state, chunk);
      this.emit('content', chunk);
    });
    adapter.on('activity', (activity: AgentActivity) => {
      pushActivity(this.state, activity);
      this.emit('activity', activity);
    });
    adapter.on('result', (data: { result: string; cost: CostInfo; sessionId: string }) => {
      this.state.status = 'done';
      this.state.finishedAt = this.now();
      this.state.sessionId = data.sessionId;

      // Accumulate cost across resume calls — same semantics as dashboard
      // (cost.stopReason prefers the freshly reported value).
      this.state.cost = accumulateCost(this.state.cost, data.cost);

      if (data.result) {
        appendOutput(this.state, data.result);
      }
      // Stamp the running aggregate cost on the session span so a single
      // trace shows total token / USD spend without re-summing children.
      if (this.sessionSpan) {
        this.sessionSpan.setAttribute('anvil.agent.total_cost_usd', this.state.cost.totalUsd);
        this.sessionSpan.setAttribute('anvil.agent.total_input_tokens', this.state.cost.inputTokens);
        this.sessionSpan.setAttribute('anvil.agent.total_output_tokens', this.state.cost.outputTokens);
        this.sessionSpan.setAttribute('anvil.agent.total_cache_read_tokens', this.state.cost.cacheReadTokens);
      }
      this.emit('result', data);
      this.closeSessionSpan('done');
    });
    adapter.on('error-output', (text: string) => {
      if (!this.state.error) this.state.error = '';
      this.state.error += text;
      this.emit('error-output', text);
    });
    adapter.on('exit', (code: number | null) => {
      // Don't override `done` or `killed` terminal states.
      if (this.state.status === 'done' || this.state.status === 'killed') {
        this.emit('exit', code);
        return;
      }
      if (code !== null && code !== 0) {
        this.state.status = 'error';
        this.state.finishedAt = this.now();
        if (!this.state.error) {
          this.state.error = `Process exited with code ${code}`;
        }
        this.emit('exit', code);
        this.closeSessionSpan('error');
        return;
      }
      // Code 0 but no result — wait briefly for late events, else flag
      // empty-output runs as an error (matches dashboard semantics).
      this.setTimeoutImpl(() => {
        if (this.state.status !== 'running') return;
        const elapsed = this.now() - (this.state.startedAt ?? this.now());
        if (
          elapsed < EMPTY_EXIT_THRESHOLD_MS
          && !this.state.output.trim()
          && this.state.cost.totalUsd === 0
        ) {
          this.state.status = 'error';
          this.state.finishedAt = this.now();
          this.state.error = this.state.error
            || 'Agent exited immediately with no output. Check workspace directory and adapter configuration.';
          this.emit('exit', code);
          this.closeSessionSpan('error');
        } else {
          this.state.status = 'done';
          this.state.finishedAt = this.now();
          this.emit('exit', code);
          this.closeSessionSpan('done');
        }
      }, POST_EXIT_GRACE_MS);
    });
  }
}

// ── Factories + helpers (exported for cross-file reuse) ─────────────────

export function createPendingState(
  spec: SpawnConfig,
  id: string,
): AgentState {
  return {
    id,
    name: spec.name,
    persona: spec.persona,
    sessionId: id,
    model: spec.model,
    status: 'pending',
    cost: emptyCost(),
    output: '',
    activities: [],
    startedAt: null,
    finishedAt: null,
    error: null,
  };
}

export function emptyCost(): CostInfo {
  return {
    totalUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    durationMs: 0,
  };
}

export function appendOutput(state: AgentState, chunk: string): void {
  state.output += chunk;
  if (state.output.length > MAX_OUTPUT_BYTES) {
    state.output = state.output.slice(-MAX_OUTPUT_BYTES);
  }
}

export function pushActivity(
  state: AgentState,
  activity: AgentActivity,
): void {
  state.activities.push(activity);
  if (state.activities.length > MAX_ACTIVITIES) {
    state.activities = state.activities.slice(-MAX_ACTIVITIES);
  }
}

export function accumulateCost(prev: CostInfo, next: CostInfo): CostInfo {
  return {
    totalUsd: prev.totalUsd + next.totalUsd,
    inputTokens: prev.inputTokens + next.inputTokens,
    outputTokens: prev.outputTokens + next.outputTokens,
    cacheReadTokens: prev.cacheReadTokens + next.cacheReadTokens,
    cacheWriteTokens: prev.cacheWriteTokens + next.cacheWriteTokens,
    durationMs: prev.durationMs + next.durationMs,
    stopReason: next.stopReason ?? prev.stopReason,
  };
}

/**
 * Generate a UUID v4. Claude CLI requires a valid v4 for `--session-id`.
 */
export function generateSessionId(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
