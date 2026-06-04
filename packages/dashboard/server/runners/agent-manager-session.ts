/**
 * `AgentManagerSession` — implements `AgentSession` over the dashboard's
 * `AgentManager`. Used by stages that need multi-turn agent semantics
 * (clarify's explore→Q&A→synthesize, QA's start→answers, fix-loop's
 * iterative fixes).
 *
 * Two modes (the canonical `AgentSession` interface is UNCHANGED — all new
 * behavior is constructor-injected via `opts.fallback`):
 *
 *  - THIN (default; fix-loop): `start(req)` spawns once, threading
 *    `req.turnRecorder` + `req.prefill` into the spawn spec; `sendInput`
 *    resumes the live `AgentProcess` (which auto-reuses `this.spec.turnRecorder`
 *    via `AgentProcess.sendInput`). The step body owns the chain-fallback +
 *    per-repo recorder (mirrors the shipped per-repo path).
 *
 *  - BURN-AWARE (clarify / QA): the session owns per-PHASE chain-fallback +
 *    a session-spanning turn recorder (under a dedicated `${stage}:session`
 *    substep) + a coarse `ctx.effect` per-phase wrap for crash-resume. On a
 *    same-process burn a phase continues from its recorded partial (cross-model
 *    where the next model is prefill-capable). §Tier 2: a RESUME phase on a
 *    non-claude model spawns fresh with `priorMessages` — the completed prior
 *    phases reconstructed from the durable log (`reconstructSessionHistory`) —
 *    so the full conversation is re-presented instead of dropped. claude keeps
 *    its native on-disk `--resume` (it carries history itself). `prefill`
 *    (the current burned turn's partial) and `priorMessages` (completed prior
 *    phases) compose.
 *
 * Crash-resume via the coarse `ctx.effect` wraps is EFFECT-granularity: a
 * recorded phase replays its whole result without ever touching the (dead)
 * `AgentProcess` — which is why claude's model-locked `--resume` can't break.
 * §H3 Fix A threaded the module-singleton store into the dashboard `Pipeline`
 * on the FORWARD pass (pipeline-loop.ts), so `ctx.effect` now records+replays
 * and the coarse wraps are live there too. CAVEAT (ADR §4.3.2 Fix A follow-up):
 * the dashboard RESUME entrypoint still mints a FRESH runId, so the recorded
 * effect log isn't replayed across a restart yet — cross-restart crash-resume
 * remains STAGE-granularity (disk artifacts + resume queue) until resume reuses
 * the original runId. Per-model cost + provenance + same-process burn
 * continuation all work via the singleton store regardless. fix-loop sets
 * `coarseWrap:false` (parallel per-repo sessions over one ctx).
 */

import type {
  AgentSession,
  AgentSessionResult,
  AgentRunRequest,
  StepContext,
} from '@esankhan3/anvil-core-pipeline';
import {
  runWithChainFallback,
  serializeAgentRunResult,
  disallowedToolsForPersona,
} from '@esankhan3/anvil-core-pipeline';
import type { AgentManager, TurnRecorder, Prefill, PrefillTurn } from '@esankhan3/anvil-agent-core';
import { spawnAndWait, waitForAgent } from '../steps/agent-spawner.js';
import { providerOfModelId } from '../pipeline-runner-types.js';

/** Resolver shape produced by `buildSessionTurnWiring`. */
type SessionResolvePrefill = (info: {
  burnedModel: string;
  attemptIndex: number;
  nextModel?: string;
}) => Promise<Prefill | undefined>;

/** §Tier 2 — reconstructs the session's completed prior turns from the log. */
type SessionResolvePriorMessages = () => Promise<PrefillTurn[]>;

/**
 * Burn-aware mode config (clarify / QA). Absent → THIN mode (fix-loop +
 * any legacy caller), byte-identical to pre-H3 except for threading
 * `req.turnRecorder`/`req.prefill` onto the spawn.
 */
export interface SessionFallbackConfig {
  /** Stage StepContext — coarse per-phase `ctx.effect` (crash-resume). */
  ctx: StepContext<string>;
  /** Chain pick; consults the shared runtime burned set + liveness. */
  resolveModel: (stageName: string) => string;
  /** Shared run-wide burned-model set (mutated on burn). */
  burnedModels: Set<string>;
  maxAttempts: number;
  onBurn?: (info: { model: string; status: number | string; message: string }) => void;
  /**
   * Build the session-spanning recorder + prefill resolver ONCE (on the
   * first `start`). The recorder outlives the call — it's threaded into
   * every spawn AND auto-reused by `AgentProcess.sendInput` on native resume.
   */
  buildWiring: (info: { stage: string; repoName?: string }) => Promise<{
    turnRecorder?: TurnRecorder;
    resolvePrefill?: SessionResolvePrefill;
    resolvePriorMessages?: SessionResolvePriorMessages;
  }>;
  /** Informational notice (e.g. cross-model resume re-materializes history). */
  warn?: (msg: string) => void;
  /**
   * Wrap each phase in a coarse `${stage}[:repo]:session:pN` `ctx.effect` for
   * EFFECT-granularity crash-resume. DEFAULT true (clarify / QA — project-level
   * single session). fix-loop sets FALSE: it runs N per-repo sessions in
   * parallel over ONE shared `ctx`, and a coarse `ctx.effect` per repo would
   * race the shared runtime's idx counter (the per-repo `ownRuntime` turn
   * recorder is already isolation-safe, so cost/provenance still record;
   * fix-loop crash-resume stays stage-granular via the validate re-run).
   */
  coarseWrap?: boolean;
}

export interface AgentManagerSessionOptions {
  agentManager: AgentManager;
  project: string;
  workspaceDir: string;
  isCancelled: () => boolean;
  /** Resolves the model to use for the initial spawn (thin mode). */
  resolveModel: (stageName: string) => string;
  onSpawn?: (agentId: string, req: AgentRunRequest) => void;
  onTruncation?: (agentName: string, outputTokens: number) => void;
  /** Burn-aware mode (clarify / QA). Omit → thin. */
  fallback?: SessionFallbackConfig;
}

export class AgentManagerSession implements AgentSession {
  constructor(private readonly opts: AgentManagerSessionOptions) {}

  // ── Burn-aware session state (unused in thin mode) ──────────────────
  private recorder?: TurnRecorder;
  private sessionResolvePrefill?: SessionResolvePrefill;
  private sessionResolvePriorMessages?: SessionResolvePriorMessages;
  private wiringBuilt = false;
  /** The model + agentId of the latest SUCCESSFUL spawn this process. */
  private currentModel?: string;
  private currentSessionId?: string;
  /** Logical phase index: 0 on start(), +1 per sendInput(). */
  private phaseIndex = -1;
  /** Base spawn req captured at start() so a resume phase can fresh-spawn. */
  private baseReq?: AgentRunRequest;

  async start(req: AgentRunRequest): Promise<AgentSessionResult> {
    this.baseReq = req;
    this.phaseIndex = 0;

    if (!this.opts.fallback) {
      // THIN: single spawn, thread the request-supplied recorder + prefill.
      const model = req.model ?? this.opts.resolveModel(req.stage);
      return this.spawnFresh(req, model, req.prefill, req.turnRecorder);
    }

    if (!this.wiringBuilt) {
      const wiring = await this.opts.fallback.buildWiring({ stage: req.stage, repoName: req.repoName });
      this.recorder = wiring.turnRecorder;
      this.sessionResolvePrefill = wiring.resolvePrefill;
      this.sessionResolvePriorMessages = wiring.resolvePriorMessages;
      this.wiringBuilt = true;
    }
    return this.runBurnAwarePhase(req, /* isResume */ false);
  }

  async sendInput(sessionId: string, text: string): Promise<AgentSessionResult> {
    this.phaseIndex += 1;

    if (!this.opts.fallback || !this.baseReq) {
      // THIN: resume the live AgentProcess (reuses its spec.turnRecorder).
      return this.nativeResume(sessionId, text);
    }
    const req: AgentRunRequest = { ...this.baseReq, userPrompt: text };
    return this.runBurnAwarePhase(req, /* isResume */ true, sessionId);
  }

  kill(sessionId: string): void {
    const agent = this.opts.agentManager.getAgent(sessionId);
    if (agent && agent.status === 'running') {
      // Best-effort; AgentManager doesn't expose a public kill, so we rely
      // on cancellation propagation through isCancelled().
    }
  }

  // ── Burn-aware per-phase execution ──────────────────────────────────

  private async runBurnAwarePhase(
    req: AgentRunRequest,
    isResume: boolean,
    resumeSessionId?: string,
  ): Promise<AgentSessionResult> {
    const fb = this.opts.fallback!;
    const phaseIndex = this.phaseIndex;
    // §Tier 2: prefill (the in-progress burned turn's partial) now applies on
    // BOTH start AND resume phases — prior-phase context is carried separately
    // via `priorMessages` (below), so a single-turn prefill on a resume phase
    // no longer drops history. They compose: priorMessages = completed prior
    // phases; prefill = the current phase's burned partial.
    const phaseResolvePrefill = this.sessionResolvePrefill;

    // §Tier 2 stateful resume: reconstruct completed prior phases ONCE per
    // phase (NOT per chain attempt — an intra-phase burn must not re-read and
    // pick up its own just-burned turn; reconstruction also skips burned
    // sentinels). START phase has no prior turns → []. Empty for the thin/
    // non-durable path (no resolver wired).
    const priorMessages: PrefillTurn[] = isResume && this.sessionResolvePriorMessages
      ? await this.sessionResolvePriorMessages()
      : [];

    // Burn-fallback MODEL chain key — may differ from `req.stage` (the
    // recording/telemetry stage). fix-loop records under 'validate' but must
    // re-resolve burns from the 'fix-loop' chain. Defaults to req.stage.
    const routingStage = req.routingStage ?? req.stage;
    const runPhase = (): Promise<AgentSessionResult> => runWithChainFallback<AgentSessionResult, Prefill>(
      {
        stageName: routingStage,
        maxAttempts: fb.maxAttempts,
        resolveModel: (exclude) => {
          // Resume phase: first attempt = the session's current model
          // (native resume for claude). On burn → chain pick.
          if (isResume && this.currentModel && !exclude.has(this.currentModel)) return this.currentModel;
          // Start phase: honor the req's model on the first attempt.
          if (!isResume && exclude.size === 0 && req.model) return req.model;
          return fb.resolveModel(routingStage);
        },
        onBurn: (info) => { fb.burnedModels.add(info.model); fb.onBurn?.(info); },
        resolvePrefill: phaseResolvePrefill,
      },
      async (model, prefill) => {
        // Native resume is ONLY correct for claude (on-disk `--resume` carries
        // the conversation). openrouter-family has no native resume, so a
        // same-model resume MUST spawn fresh with reconstructed `priorMessages`
        // — otherwise prior turns are silently dropped (the bug Tier 2 fixes).
        const canNativeResume = isResume
          && !prefill
          && resumeSessionId !== undefined
          && resumeSessionId === this.currentSessionId
          && model === this.currentModel
          && providerOfModelId(model) === 'claude';
        if (canNativeResume) {
          return this.nativeResume(resumeSessionId!, req.userPrompt);
        }
        if (isResume) {
          if (priorMessages.length > 0) {
            fb.warn?.(
              `[${req.stage}] resume on ${model}: re-materializing ${priorMessages.length} prior turn(s) ` +
              `(no native session resume for ${providerOfModelId(model)})`,
            );
          } else {
            // §Tier 2 cross-vendor gap: a prior phase authored by a
            // non-recording adapter (claude/ollama/gemini/adk) wrote no
            // `turn:N:*` effects, so there's nothing to reconstruct — the
            // successor loses that history. NOT silent: surface it. The full
            // fix is recording turns for those adapters (ADR Phase H4 — "port
            // remaining adapters").
            fb.warn?.(
              `[${req.stage}] resume on ${model}: 0 prior turns reconstructed — a prior phase was ` +
              `authored by a non-recording adapter; its conversation history will NOT be re-presented (H4).`,
            );
          }
        }
        return this.spawnFresh(req, model, prefill, this.recorder, priorMessages);
      },
    );

    // Coarse per-phase ctx.effect → crash-resume replays the WHOLE phase
    // result without touching the (possibly-dead) AgentProcess (so claude's
    // model-locked `--resume` can't fail). The per-phase burn continuation
    // happens INSIDE this effect's fn on the live path; the effect only
    // short-circuits on REPLAY. SKIPPED when `coarseWrap === false` (fix-loop:
    // parallel per-repo sessions over one shared ctx would race the idx
    // counter — see SessionFallbackConfig.coarseWrap).
    if (fb.coarseWrap === false) {
      return serializeAgentRunResult(
        await runPhase() as unknown as Record<string, unknown>,
      ) as unknown as AgentSessionResult;
    }
    const repoScope = req.repoName ? `:${req.repoName}` : '';
    return fb.ctx.effect(
      `${req.stage}${repoScope}:session:p${phaseIndex}`,
      async () => serializeAgentRunResult(
        await runPhase() as unknown as Record<string, unknown>,
      ) as unknown as AgentSessionResult,
    );
  }

  // ── Spawn primitives ────────────────────────────────────────────────

  private async spawnFresh(
    req: AgentRunRequest,
    model: string,
    prefill: Prefill | undefined,
    recorder: TurnRecorder | undefined,
    priorMessages?: PrefillTurn[],
  ): Promise<AgentSessionResult> {
    const cwd = req.workingDir || this.opts.workspaceDir;
    const result = await spawnAndWait({
      agentManager: this.opts.agentManager,
      spec: {
        name: `${req.persona}-${this.opts.project}-${req.repoName ?? 'root'}`,
        persona: req.persona,
        project: this.opts.project,
        stage: req.repoName ? `${req.stage}:${req.repoName}` : req.stage,
        prompt: req.userPrompt,
        model,
        cwd,
        projectPrompt: req.projectPrompt,
        permissionMode: 'bypassPermissions',
        disallowedTools: req.disallowedTools
          ? [...req.disallowedTools]
          : [...disallowedToolsForPersona(req.persona)],
        allowedTools: req.allowedTools ? [...req.allowedTools] : undefined,
        maxOutputTokens: req.maxOutputTokens,
        turnRecorder: recorder,
        prefill,
        // §Tier 2: completed prior phases re-presented to a non-claude resume.
        ...(priorMessages && priorMessages.length > 0 ? { priorMessages } : {}),
      },
      isCancelled: this.opts.isCancelled,
      onSpawn: (agentId) => this.opts.onSpawn?.(agentId, req),
      onTruncation: this.opts.onTruncation,
    });
    this.currentModel = model;
    this.currentSessionId = result.agentId;
    return {
      sessionId: result.agentId,
      output: result.artifact,
      tokenEstimate: (result.inputTokens ?? 0) + (result.outputTokens ?? 0),
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheWriteTokens: result.cacheWriteTokens,
      costUsd: result.cost,
      agentId: result.agentId,
      model,
    };
  }

  private async nativeResume(sessionId: string, text: string): Promise<AgentSessionResult> {
    // AgentManager feeds the message — it spawns a fresh adapter with
    // resume=true and the same sessionId, reusing this.spec.turnRecorder.
    this.opts.agentManager.sendInput(sessionId, text);
    const completed = await waitForAgent({
      agentId: sessionId,
      agentManager: this.opts.agentManager,
      isCancelled: this.opts.isCancelled,
      onTruncation: this.opts.onTruncation,
    });
    this.currentSessionId = sessionId;
    return {
      sessionId,
      output: completed.artifact,
      tokenEstimate: (completed.inputTokens ?? 0) + (completed.outputTokens ?? 0),
      inputTokens: completed.inputTokens,
      outputTokens: completed.outputTokens,
      cacheReadTokens: completed.cacheReadTokens,
      cacheWriteTokens: completed.cacheWriteTokens,
      costUsd: completed.cost,
      agentId: sessionId,
    };
  }
}
