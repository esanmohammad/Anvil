/**
 * TurnRecorder — splits one LLM invocation into per-turn sub-effects so
 * the durable engine can replay tool results and resume mid-stream after
 * a chain-fallback model swap.
 *
 * Effect-name vocabulary (per the v2 ADR §2.1):
 *   - `turn:<N>:assistant-start`     — request payload, hashed for replay
 *   - `turn:<N>:tool_use:<M>`        — intent (name + parsed args)
 *   - `turn:<N>:tool_result:<M>`     — neutral result; replay short-circuits the executor
 *   - `turn:<N>:assistant-end`       — completed assistant text + provenance
 *
 * Surface note vs ADR §2.5: the ADR sketches recordToolUse / recordToolResult
 * as two separate calls. That split has no clean replay-vs-execute boundary
 * through the `effect(name, fn)` interface — once the runtime accepts a fn
 * for `tool_result:N`, fn already either ran (live) or didn't (replay), and
 * the caller can't tell from outside. So the implementation collapses to a
 * single `runTool(turn, name, args, key, exec)` that owns the
 * intent-record → execute-or-replay → result-record sequence atomically.
 * Same on-disk shape; cleaner adapter code; ADR §2.5 to be amended in
 * follow-up.
 *
 * NullTurnRecorder factory: pass a `createNullRuntime()`-built runtime to
 * make every call a no-op pass-through with live execution. Adapters that
 * haven't been ported through their own H-phase use this default, so the
 * recorder calls compile and run today without behavior change.
 */

import type {
  AssistantPartial,
  AssistantStartRequest,
  AssistantTurn,
  EffectRuntimeLike,
  NeutralToolResult,
  PartialReason,
  PartialSink,
  Provenance,
  RecordedToolUse,
  TurnRecorderDeps,
  TurnTokenUsage,
} from './types.js';
import type { ProviderName } from '../types.js';
import { contentHashFromArgs } from './hash.js';

const DEFAULT_UUID = (): string =>
  (globalThis.crypto?.randomUUID?.() ?? fallbackUuid());

function fallbackUuid(): string {
  // Minimal v4 fallback for runtimes without globalThis.crypto.
  const hex = (n: number): string => n.toString(16).padStart(2, '0');
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = Array.from(bytes, hex);
  return `${h.slice(0, 4).join('')}-${h.slice(4, 6).join('')}-${h.slice(6, 8).join('')}-${h.slice(8, 10).join('')}-${h.slice(10, 16).join('')}`;
}

export class TurnRecorder {
  private readonly deps: TurnRecorderDeps;
  /** Monotonic turn counter, scoped to this recorder (one per adapter.run).
   *  Seeded from deps.initialTurn so a sendInput-resume recorder continues
   *  past the prior adapter's turns (§2.5.1). */
  private turnCounter: number;
  /** Per-turn tool_use index counter — bumped serially per call. */
  private readonly toolIdxByTurn = new Map<number, number>();
  /** Per-turn uuid stash so flushPartial can echo the right one. */
  private readonly turnUuids = new Map<number, string>();
  /** Per-turn (model, provider) stash from startTurn so endTurn can
   *  stamp the assistant-end payload — the H3 cost rollup prices each
   *  turn by its authoring model. */
  private readonly turnMeta = new Map<number, { model: string; provider: ProviderName }>();

  /** Per-repo effect-name scope (e.g. `service-a:`); '' for single-stage. */
  private readonly prefix: string;

  constructor(deps: TurnRecorderDeps) {
    this.deps = deps;
    this.turnCounter = deps.initialTurn ?? 0;
    this.prefix = deps.effectPrefix ?? '';
  }

  /** Scoped effect name for a turn sub-effect. */
  private key(name: string): string {
    return `${this.prefix}${name}`;
  }

  /**
   * Open a new assistant turn. Records the request payload as an
   * `assistant-start` effect; on replay, returns the recorded turn's
   * full transcript so the adapter can skip the upstream call entirely.
   */
  async startTurn(req: AssistantStartRequest): Promise<{
    turn: number;
    turnUuid: string;
    /** Present iff the matching `assistant-end` is already in the log. */
    replayed?: AssistantTurn;
  }> {
    const turn = this.turnCounter++;
    const turnUuid = this.uuid();
    this.turnUuids.set(turn, turnUuid);
    this.toolIdxByTurn.set(turn, 0);
    this.turnMeta.set(turn, { model: req.model, provider: req.provider });

    const idempotencyKey = contentHashFromArgs({
      model: req.model,
      provider: req.provider,
      system: req.system ?? '',
      messages: req.messages,
      prefillTurnUuid: req.prefill?.turnUuid,
    });

    // Record the start. On replay this is a no-op that returns the
    // recorded payload — we don't use the return value here because
    // the meaningful replay signal is whether `assistant-end` exists.
    await this.deps.runtime.effect(
      this.key(`turn:${turn}:assistant-start`),
      async () => ({
        turnUuid,
        model: req.model,
        provider: req.provider,
        prefillTurnUuid: req.prefill?.turnUuid ?? null,
        // §Tier 2: persist the phase's user prompt so a stateful resume can
        // reconstruct prior turns WITH their prompts. NOT in `idempotencyKey`
        // (above) — `messages` already covers it for the replay hash; storing
        // it here is additive and never re-read by replay-skip (which reads
        // assistant-end), so it cannot perturb determinism.
        userPrompt: req.userPrompt ?? null,
      }),
      { idempotencyKey, smallResult: true },
    );

    // H3 replay-skip: if this turn's `assistant-end` is already in the
    // durable log, the whole turn ran on a prior process. Reconstruct
    // it so the adapter skips the upstream call and re-appends the
    // recorded native history verbatim. `peekRecorded` is a pure read
    // (no cursor/idx mutation) — the adapter still calls runTool/endTurn
    // in order to advance the replay cursor over the recorded sub-effects.
    const replayed = this.tryReconstructTurn(turn, turnUuid);
    if (replayed) return { turn, turnUuid, replayed };

    return { turn, turnUuid };
  }

  /**
   * Peek the durable log for a fully-recorded turn N. Returns the
   * reconstructed `AssistantTurn` iff `turn:N:assistant-end` exists;
   * undefined on the live path (peek unsupported, or end not yet
   * recorded). Pure reads only — no effect cursor is advanced here.
   */
  private tryReconstructTurn(turn: number, turnUuid: string): AssistantTurn | undefined {
    const peek = this.deps.runtime.peekRecorded?.bind(this.deps.runtime);
    if (!peek) return undefined;

    const end = peek<{
      text?: string;
      stopReason?: string;
      usage?: TurnTokenUsage;
      provenance?: Provenance;
      historyDelta?: unknown[];
    }>(this.key(`turn:${turn}:assistant-end`));
    if (!end) return undefined;

    const toolUses: RecordedToolUse[] = [];
    const toolResults: NeutralToolResult[] = [];
    for (let m = 0; ; m += 1) {
      const tu = peek<{ name?: string; arguments?: Record<string, unknown>; idempotencyKey?: string }>(
        this.key(`turn:${turn}:tool_use:${m}`),
      );
      if (!tu) break;
      const tr = peek<NeutralToolResult>(this.key(`turn:${turn}:tool_result:${m}`));
      toolUses.push({
        // `id` isn't in the tool_use payload; the matching tool_result
        // carries `toolUseId` (the provider id). Used only for cosmetic
        // re-emit on replay — runTool keys off (name, idx, idempotencyKey).
        id: tr?.toolUseId ?? '',
        name: tu.name ?? '',
        arguments: tu.arguments ?? {},
        idempotencyKey: tu.idempotencyKey ?? '',
      });
      if (tr) toolResults.push(tr);
    }

    return {
      turnUuid,
      turn,
      text: end.text ?? '',
      stopReason: end.stopReason ?? 'end_turn',
      usage: end.usage ?? { inputTokens: 0, outputTokens: 0 },
      provenance: end.provenance ?? { segments: [] },
      toolUses,
      toolResults,
      historyDelta: end.historyDelta ?? [],
    };
  }

  /**
   * Record a tool intent + execute (or replay) the tool. Combines what
   * the ADR drafted as two calls into one atomic sequence. The
   * `idempotencyKey` is hashed by the caller (or fed in pre-computed)
   * and guards against args drift on replay.
   *
   * Replay behavior: the inner `tool_result:M` effect is replayed
   * verbatim — `exec()` is NOT invoked. Side effects (file writes, bash
   * runs) stay as the prior model left them.
   */
  async runTool(
    turn: number,
    name: string,
    args: Record<string, unknown>,
    idempotencyKey: string,
    exec: () => Promise<NeutralToolResult>,
  ): Promise<NeutralToolResult> {
    const idx = this.bumpToolIdx(turn);

    await this.deps.runtime.effect(
      this.key(`turn:${turn}:tool_use:${idx}`),
      async () => ({ name, arguments: args, idempotencyKey }),
      { idempotencyKey, smallResult: true },
    );

    const result = await this.deps.runtime.effect(
      this.key(`turn:${turn}:tool_result:${idx}`),
      exec,
    );

    return result;
  }

  /**
   * Close an assistant turn with the completed text, stop reason, usage,
   * and provenance. Records `assistant-end`; on replay this is a no-op.
   */
  async endTurn(
    turn: number,
    text: string,
    stopReason: string,
    usage: TurnTokenUsage,
    provenance: Provenance,
    /**
     * Provider-native messages appended to history this turn (assistant
     * + tool-result messages). Recorded so crash-resume re-appends them
     * byte-for-byte (§ AssistantTurn.historyDelta). Default [] for the
     * terminal no-tool turn (nothing appended). Opaque to the recorder.
     */
    historyDelta: unknown[] = [],
  ): Promise<void> {
    const meta = this.turnMeta.get(turn);
    await this.deps.runtime.effect(
      this.key(`turn:${turn}:assistant-end`),
      async () => ({
        text,
        stopReason,
        usage,
        provenance,
        historyDelta,
        // model + provider stamp lets the H3 per-model cost rollup price
        // this turn's tokens by its authoring model.
        model: meta?.model,
        provider: meta?.provider,
      }),
      { smallResult: text.length < 4_000 },
    );
  }

  /**
   * Flush an in-progress assistant text to the partial sink. Called from
   * an adapter's catch block BEFORE re-throwing UpstreamError. Does NOT
   * go through `effect()` — partial events are not subject to the
   * (name, idx) counter; they're durable signals scoped by turnUuid.
   *
   * Safe to call when text is empty (sink decides whether to bother).
   * Safe to call multiple times for the same turn — the sink handles
   * dedup via turnUuid + recordedAt.
   */
  flushPartial(
    turn: number,
    text: string,
    toolUsesEmitted: number,
    reason: PartialReason,
  ): void {
    const turnUuid = this.turnUuids.get(turn);
    if (!turnUuid) return; // startTurn was never called — nothing to flush.
    const partial: AssistantPartial = {
      runId: this.deps.runId,
      stepId: this.deps.stepId,
      turnUuid,
      turn,
      text,
      toolUsesEmitted,
      reason,
      recordedAt: this.nowIso(),
    };
    try {
      this.deps.partialSink(partial);
    } catch (err) {
      // Sink should be a fire-and-forget; if it throws we still re-throw
      // the upstream error — log to stderr so the failure is visible.
      process.stderr.write(
        `[turn-recorder] partialSink threw: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Internals
  // ─────────────────────────────────────────────────────────────────

  private bumpToolIdx(turn: number): number {
    const next = this.toolIdxByTurn.get(turn) ?? 0;
    this.toolIdxByTurn.set(turn, next + 1);
    return next;
  }

  private uuid(): string {
    return this.deps.uuid?.() ?? DEFAULT_UUID();
  }

  private nowIso(): string {
    return this.deps.nowIso?.() ?? new Date().toISOString();
  }
}

// ─────────────────────────────────────────────────────────────────────
// Null runtime — for adapters that haven't yet been wired to a real
// EffectRuntime. Calls execute live; nothing is recorded; replay is a
// no-op (since nothing is on disk). Lets us land the H1 recorder calls
// without forcing every adapter or every call-site to thread a real
// EffectRuntime through agent-core's bridge today.
// ─────────────────────────────────────────────────────────────────────

export function createNullEffectRuntime(): EffectRuntimeLike {
  return {
    async effect<T>(_name: string, fn: () => Promise<T>): Promise<T> {
      return await fn();
    },
  };
}

export function createNullPartialSink(): PartialSink {
  return () => { /* dropped on the floor */ };
}

/**
 * Convenience factory: a TurnRecorder that does the right structural
 * thing (records → executes → emits) but persists nothing. Adapters use
 * this when their caller hasn't supplied a real runtime + sink. Identical
 * observable behavior to today's adapters; opens the door for the H2+
 * wiring to inject the real instances without touching adapter code
 * again.
 */
export function createNullTurnRecorder(opts?: {
  runId?: string;
  stepId?: string;
}): TurnRecorder {
  return new TurnRecorder({
    runtime: createNullEffectRuntime(),
    partialSink: createNullPartialSink(),
    runId: opts?.runId ?? 'null-run',
    stepId: opts?.stepId ?? 'null-step',
  });
}

export type { TurnRecorderDeps } from './types.js';
export * from './types.js';
