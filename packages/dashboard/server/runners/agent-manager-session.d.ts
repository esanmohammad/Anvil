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
import type { AgentSession, AgentSessionResult, AgentRunRequest, StepContext } from '@esankhan3/anvil-core-pipeline';
import type { AgentManager, TurnRecorder, Prefill, PrefillTurn, ErrorClass } from '@esankhan3/anvil-agent-core';
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
    onBurn?: (info: {
        model: string;
        status: number | string;
        message: string;
        errorClass: ErrorClass;
        delayMs: number;
    }) => void;
    /**
     * Build the session-spanning recorder + prefill resolver ONCE (on the
     * first `start`). The recorder outlives the call — it's threaded into
     * every spawn AND auto-reused by `AgentProcess.sendInput` on native resume.
     */
    buildWiring: (info: {
        stage: string;
        repoName?: string;
    }) => Promise<{
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
export declare class AgentManagerSession implements AgentSession {
    private readonly opts;
    constructor(opts: AgentManagerSessionOptions);
    private recorder?;
    private sessionResolvePrefill?;
    private sessionResolvePriorMessages?;
    private wiringBuilt;
    /** The model + agentId of the latest SUCCESSFUL spawn this process. */
    private currentModel?;
    private currentSessionId?;
    /** Logical phase index: 0 on start(), +1 per sendInput(). */
    private phaseIndex;
    /** Base spawn req captured at start() so a resume phase can fresh-spawn. */
    private baseReq?;
    start(req: AgentRunRequest): Promise<AgentSessionResult>;
    sendInput(sessionId: string, text: string): Promise<AgentSessionResult>;
    kill(sessionId: string): void;
    private runBurnAwarePhase;
    private spawnFresh;
    private nativeResume;
}
export {};
//# sourceMappingURL=agent-manager-session.d.ts.map