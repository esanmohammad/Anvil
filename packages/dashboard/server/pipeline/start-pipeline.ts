/**
 * Pipeline start orchestrator (Phase 3 round-4 extraction from
 * `dashboard-server.ts`).
 *
 * `createStartPipeline(deps)` returns the `startPipeline(project, feature,
 * options)` closure used by the build-trigger handler + plan-seeded
 * lifecycle. The body is verbatim from the legacy closure (lines 1253–
 * 1924 in the pre-extraction file); closure-resident state
 * (`activePipelineRunner`, `activeChild`, `outputBuffer`, `activeRuns`,
 * `agentToRunId`) stays in dashboard-server's scope and is reached
 * through getter/setter callbacks so the legacy "register-before-spawn"
 * + "restore-spawn-on-complete" semantics are preserved.
 *
 * The factory owns no mutable state of its own; every per-run scratch
 * (pipelineRunId, pipelineActivities, the bus + hook detach handles,
 * the original-spawn ref) lives inside the returned closure.
 *
 * The cost-hook and checkpoint-hook attach to the AgentManager
 * singleton (not per-run); since they close over `info.runId` +
 * `info.project` they keep working across consecutive runs. The
 * spawn-patch is per-run and restored on terminal events.
 */

import { writeFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';

import {
  InMemoryEventBus,
  attachAuditLogHook,
  attachCostTrackerHook,
  attachDashboardStateHook,
  attachLearnersHook,
} from '@esankhan3/anvil-core-pipeline';
import {
  attachPipelineBusSubscriber,
  type PipelineStepDescriptor,
} from '../pipeline-bus-subscriber.js';
import { loadPolicy, evaluatePolicy } from '../pipeline-policy.js';
import type { PipelinePolicy } from '../pipeline-policy-types.js';
import { notifyPipelinePaused } from '../pipeline-notifier.js';
import { createApprovalToken } from '../pipeline-approval-tokens.js';
import { autoLearn } from '../pipeline-learner.js';
import {
  BlobStore,
  CheckpointStore,
  computeKey as computeCheckpointKey,
} from '@esankhan3/anvil-agent-core';
import { CheckpointSimilarityIndex } from '../checkpoint-similarity-index.js';
import { embedPrompt } from '../prompt-similarity.js';

import { PipelineRunner } from '../pipeline-runner.js';
import type { PipelineRunState } from '../pipeline-runner.js';

import type { AgentManager } from '@esankhan3/anvil-agent-core';
import type { ProjectLoader } from '../project-loader.js';
import type { FeatureStore } from '../feature-store.js';
import type { MemoryStore } from '../memory-store.js';
import type { KnowledgeBaseManager } from '../knowledge-base-manager.js';
import type { TestSpecStore } from '../test-spec-store.js';
import type { TestCaseStore } from '../test-case-store.js';
import type { PipelinePauseStore } from '../pipeline-pause-store.js';
import type { PipelineAuditLog } from '../pipeline-audit-log.js';
import type { CostLedger } from '../cost-ledger.js';
import type { CostBreachHandler } from '../cost-breach-handler.js';
import type { DashboardServices } from '../services/index.js';
import type { Plan } from '../plan-store.js';
import type { Persona } from '../review-store.js';
import type {
  ActiveRun,
  ActivityEntry,
} from '../broadcasts.js';
import type {
  DashboardState,
  DashboardPipeline,
} from '../dashboard-server.js';
import type { ChildProcess } from 'node:child_process';

/** Options accepted by `startPipeline()`. Mirrors the legacy union. */
export interface StartPipelineOptions {
  skipClarify?: boolean;
  skipShip?: boolean;
  model?: string;
  models?: Record<string, string>;
  approvalRequired?: boolean;
  baseBranch?: string;
  modelTier?: 'fast' | 'balanced' | 'thorough';
  repo?: string;
  level?: string;
  deploy?: unknown;
  resumeFromStage?: number;
  featureSlug?: string;
  failureContext?: string;
  clarifySeedArtifact?: string;
  planSeed?: { project: string; slug: string; version: number; plan: Plan };
  /**
   * Reuse an existing pipeline runId instead of minting a fresh one.
   * Threaded by the resume path (Replay button + auto-resume queue) so
   * `Pipeline.run()` reads the durable event log keyed by the ORIGINAL
   * runId and replays its `step:completed` + recorded effects. Without
   * this, resume minted a fresh `build-<ts>` id, so the log lookup hit
   * an empty set and effect-granularity crash-resume never engaged
   * (BUG-1 Fix A, finding 7). `createRun` is idempotent on an existing
   * runId, so re-registering the same id is store-safe.
   */
  resumeRunId?: string;
}

export interface StartPipelineDeps {
  // Stores + services
  agentManager: AgentManager;
  projectLoader: ProjectLoader;
  featureStore: FeatureStore;
  memoryStore: MemoryStore;
  kbManager: KnowledgeBaseManager;
  testSpecStore: TestSpecStore;
  testCaseStore: TestCaseStore;
  pauseStore: PipelinePauseStore;
  auditLog: PipelineAuditLog;
  costLedger: CostLedger;
  costBreachHandler: CostBreachHandler;
  blobStore: BlobStore;
  checkpointStore: CheckpointStore;
  services: DashboardServices;

  // Closure-owned state (mutable on dashboard-server side)
  activeRuns: Map<string, ActiveRun>;
  agentToRunId: Map<string, string>;
  getActivePipelineRunner: () => PipelineRunner | null;
  setActivePipelineRunner: (runner: PipelineRunner | null) => void;
  getActiveChild: () => ChildProcess | null;
  setActiveChild: (child: ChildProcess | null) => void;
  /** Reset dashboard-server's outputBuffer `let` binding. */
  resetOutputBuffer: () => void;
  /** Append a single entry to dashboard-server's outputBuffer. */
  pushOutputEntry: (entry: ActivityEntry) => void;

  // Broadcasters
  broadcastActiveRuns: () => void;
  broadcastRuns: () => void;
  broadcastCostSnapshot: (project: string, runId?: string) => void;

  // Run-bookkeeping (post-run + lifecycle + PR tracking + auto-review)
  persistRunRecord: (state: PipelineRunState, runId?: string) => Promise<void>;
  extractPRUrls: (content: string) => string[];
  trackPR: (prUrl: string) => Promise<void>;
  dispatchLifecycle: (
    project: string,
    slug: string,
    event:
      | { kind: 'execute-complete' }
      | { kind: 'reconcile-complete' }
      | { kind: 'execute-failed'; reason: string },
  ) => Promise<unknown>;
  startReviewRun: (
    project: string,
    prUrl: string,
    sourceStage: 'ship',
    personas: Persona[],
    model?: string,
  ) => Promise<unknown>;

  // Paths + approval
  anvilHome: string;
  runsDir: string;
  stateFile: string;
  approvalSecret: string;
}

export type StartPipelineFn = (
  project: string,
  feature: string,
  options?: StartPipelineOptions,
) => void;

export function createStartPipeline(deps: StartPipelineDeps): StartPipelineFn {
  return function startPipeline(project, feature, options) {
    // Kill any existing pipeline
    const existingRunner = deps.getActivePipelineRunner();
    if (existingRunner) existingRunner.cancel();
    const existingChild = deps.getActiveChild();
    if (existingChild) {
      existingChild.kill('SIGTERM');
      deps.setActiveChild(null);
    }
    deps.resetOutputBuffer();

    // Register the run + broadcast BEFORE any setup work. Without this the
    // user clicks Build and sees Active Runs stay stale for a beat while
    // the runner constructs hooks. Visible activity ID is the same one we
    // pass to activeRuns.set later (replaced rather than re-registered).
    // Resume reuses the ORIGINAL runId so the durable log keyed by it
    // replays; a fresh user-initiated build mints a new one. See
    // StartPipelineOptions.resumeRunId.
    const pipelineRunId = options?.resumeRunId ?? `build-${Date.now().toString(36)}`;
    if (options?.resumeRunId) {
      console.log(
        `[dashboard] resuming with original runId ${pipelineRunId} — durable replay enabled`,
      );
    }
    const pipelineActivities: ActivityEntry[] = [];
    // Seed an initial activity so the per-stage panel isn't blank while
    // the runner spins up (workspace bootstrap + manifest load + walker
    // prefetch). Without this the dashboard renders "No output for this
    // stage yet" for the first few seconds even though work is happening.
    const seedEntry: ActivityEntry = {
      timestamp: Date.now(),
      stage: 'clarify',
      type: 'stdout',
      content: 'Initialising pipeline — workspace + provider liveness…',
      kind: 'project',
    };
    pipelineActivities.push(seedEntry);
    deps.pushOutputEntry(seedEntry);
    deps.activeRuns.set(pipelineRunId, {
      id: pipelineRunId,
      type: 'build',
      project,
      description: feature,
      model: options?.model ?? 'sonnet',
      status: 'running',
      startedAt: Date.now(),
      activities: pipelineActivities,
      prUrls: new Set(),
    });
    deps.broadcastActiveRuns();
    deps.services.agents.emit('agent.output', { entries: [seedEntry], runId: pipelineRunId } as never);

    const runner = new PipelineRunner(
      deps.agentManager,
      deps.projectLoader,
      deps.featureStore,
      {
        runId: pipelineRunId,
        project,
        feature,
        model: options?.model ?? 'sonnet',
        modelTier: options?.modelTier,
        baseBranch: options?.baseBranch,
        skipClarify: options?.skipClarify,
        skipShip: options?.skipShip,
        deploy: (options as { deploy?: unknown } | undefined)?.deploy,
        resumeFromStage: options?.resumeFromStage,
        featureSlug: options?.featureSlug,
        failureContext: options?.failureContext,
        clarifySeedArtifact: options?.clarifySeedArtifact,
        planSeed: options?.planSeed,
      } as ConstructorParameters<typeof PipelineRunner>[3],
      deps.memoryStore,
      deps.kbManager,
    );

    // ── Phase 2: core-pipeline EventBus + lifecycle hooks ───────────────
    // The bus is constructed per-run. Phase 4 will rewrite pipeline-runner to
    // emit through this bus; until then no publishers exist on it and the
    // hooks sit idle. The wiring is in place so Phase 4 lands as a swap.
    // State-file polling stays as the cross-process fallback.
    const initialState = runner.getState();
    const pipelineBus = new InMemoryEventBus();
    const stepDescriptors: PipelineStepDescriptor[] = initialState.stages.map((s) => ({
      id: s.name,
      name: s.name,
      label: s.label,
      perRepo: s.perRepo,
    }));
    const auditLogPath = join(deps.runsDir, initialState.runId, 'audit.jsonl');
    const auditHook = attachAuditLogHook(pipelineBus, { path: auditLogPath });
    const stateHook = attachDashboardStateHook(pipelineBus, { path: deps.stateFile });
    const costHook = attachCostTrackerHook(pipelineBus);
    const learnersHook = attachLearnersHook(pipelineBus, {
      project,
      onLearnEvent: (event) => {
        const payload = event.payload as { state?: PipelineRunState } | undefined;
        if (payload?.state) autoLearn(deps.memoryStore, payload.state);
      },
    });
    const busSubscriber = attachPipelineBusSubscriber(pipelineBus, {
      project,
      feature,
      featureSlug: initialState.featureSlug,
      model: initialState.model,
      repoNames: initialState.repoNames,
      steps: stepDescriptors,
      // Phase 8: route bus-driven state snapshots through the typed
      // system service. socket.io bridge fans them to clients.
      broadcast: (msg) => {
        if (msg.type === 'state' && msg.payload && typeof msg.payload === 'object') {
          deps.services.system.emit('state', { state: msg.payload as DashboardState });
        }
      },
    });
    const detachBus = (): void => {
      busSubscriber.unsubscribe();
      auditHook.unsubscribe();
      stateHook.unsubscribe();
      stateHook.flush();
      costHook.unsubscribe();
      learnersHook.unsubscribe();
    };

    // ── Feature-flagged policy hook: pause after configured stages ──
    {
      runner.setAfterStageHook(async (info) => {
        // Gate purely on the project's policy YAML — no env var. Projects
        // without a pipeline-policy.yaml get no pauses.
        const policy = loadPolicy(info.project, deps.anvilHome);
        if (!policy) return;
        // Map the runner's fine-grained stage taxonomy onto the policy's
        // 5-stage taxonomy. Critical: the `plan` bucket fires ONLY after
        // `tasks` — the last plan-stage. Mapping earlier plan-stages
        // (clarify/requirements/etc.) to `plan` would pause as soon as
        // clarify finishes, before the user has any plan to review.
        // Earlier plan-stages return `null` here (no policy check).
        const stageAsPipelineStage = ((): 'plan' | 'implement' | 'review' | 'test' | 'ship' | null => {
          switch (info.stageName) {
            case 'clarify':
            case 'requirements':
            case 'repo-requirements':
            case 'specs':
              return null; // policy hook skips mid-plan stages
            case 'tasks':
              return 'plan'; // last plan-stage — this is where pauseAfter:['plan'] fires
            case 'build':
              return 'implement';
            case 'test':
            case 'validate':
              return 'test';
            case 'ship':
              return 'ship';
            default:
              return 'implement';
          }
        })();
        if (stageAsPipelineStage === null) return;
        const decision = evaluatePolicy(policy, {
          stage: stageAsPipelineStage,
          touchedFiles: info.touchedFiles ?? [],
          riskTier: info.riskTier,
          confidence: info.confidence,
        });
        if (!decision.pause) return;

        const pause = deps.pauseStore.pause({
          runId: info.runId,
          project: info.project,
          stage: stageAsPipelineStage,
          reason: decision.reason,
          matchedRules: decision.matchedRules,
          reviewers: decision.reviewers,
          timeoutHours: policy.notifications?.timeoutHours,
        });
        deps.services.pipeline.emit('pipeline.paused', { pause });
        deps.auditLog.record({
          runId: info.runId, project: info.project,
          event: 'paused', actor: 'system',
          details: { reviewers: pause.reviewers, reason: pause.reason },
        });

        // Fire-and-forget notification + approve-link
        try {
          const token = createApprovalToken(info.runId, 'approve', deps.approvalSecret, 24);
          const base = process.env.ANVIL_DASHBOARD_URL;
          void notifyPipelinePaused(pause, base, token);
        } catch { /* ignore */ }

        // Block until the pause transitions out of 'paused-awaiting-user'.
        await new Promise<void>((resolve) => {
          const tick = setInterval(() => {
            const latest = deps.pauseStore.get(info.runId);
            if (!latest || latest.status !== 'paused-awaiting-user') {
              clearInterval(tick);
              resolve();
            }
          }, 1000);
        });

        const final = deps.pauseStore.get(info.runId);
        if (final?.resumeDecision?.action === 'cancel') {
          throw new Error(`pipeline cancelled at ${info.stageName}`);
        }
        // Hand the reviewer's note off to the runner so the NEXT stage's
        // user prompt picks it up via the prompt-builder context. Empty
        // / missing notes are silently ignored by the runner.
        const note = final?.resumeDecision?.note;
        if (typeof note === 'string' && note.trim().length > 0) {
          runner.setReviewNote(note);
        }
        // Phase B — `modify-artifact`: replace the just-completed stage's
        // artifact with the reviewer's edited markdown. The runner's
        // applyArtifactEdit re-writes disk state and arms the override
        // so the next stage's `prevArtifact` is the edited body.
        if (final?.resumeDecision?.action === 'modify-artifact'
            && typeof final.resumeDecision.editedArtifact === 'string'
            && final.resumeDecision.editedArtifact.length > 0) {
          runner.applyArtifactEdit(info.stageIndex, final.resumeDecision.editedArtifact);
        }
        // Phase C — `rerun-from`: roll the pipeline loop back to the
        // chosen stage. Default target is the just-paused stage (rerun
        // it with the note). Out-of-range indices are silently dropped
        // by the runner — clamp to the current stage as a safety net.
        if (final?.resumeDecision?.action === 'rerun-from') {
          const requested = typeof final.resumeDecision.rerunFromStage === 'number'
            ? final.resumeDecision.rerunFromStage
            : info.stageIndex;
          const clamped = Math.max(0, Math.min(requested, info.stageIndex));
          runner.requestRerunFromStage(clamped, final.resumeDecision.note ?? null);
        }
        // Phase F — `iterate-with-note`: re-run only the just-paused
        // stage with the note framed as reviewer feedback. No manifest
        // clear, no rewind to prior stages, no failureContext framing.
        if (final?.resumeDecision?.action === 'iterate-with-note') {
          runner.iterateCurrentStageWithNote(info.stageIndex, final.resumeDecision.note ?? null);
        }
      });
    }

    // ── Cost ledger hook — gated per-project by policy.cost in pipeline-policy.yaml ──
    {
      deps.agentManager.setCostHook((info) => {
        if (!info.project || !info.runId) return;
        // Read policy first — if no cost block, skip the entire hook for this project.
        let policy: PipelinePolicy | null;
        try {
          policy = loadPolicy(info.project, deps.anvilHome);
        } catch {
          policy = null;
        }
        if (!policy?.cost) return;

        const stage = (
          ['plan', 'implement', 'review', 'test', 'ship'].includes(info.stage ?? '')
            ? info.stage
            : 'other'
        ) as 'plan' | 'implement' | 'review' | 'test' | 'ship' | 'other';
        try {
          deps.costLedger.record({
            runId: info.runId, project: info.project, stage,
            agent: info.persona, model: info.model,
            tokensIn: info.tokensIn, tokensOut: info.tokensOut,
            cacheReadTokens: info.cacheReadTokens,
            cacheWriteTokens: info.cacheWriteTokens,
          });
        } catch { /* ledger best-effort */ }
        try {
          void deps.costBreachHandler.evaluate(info.runId, info.project, {
            limits: policy.cost.limits,
            graceWindowSeconds: policy.cost.graceWindowSeconds,
            onBreach: policy.cost.onBreach,
            autoApproveBelow: policy.cost.autoApproveBelow,
          });
        } catch { /* ignore */ }
        // Push fresh snapshot so meters / cards / modal stay live.
        if (info.project && info.runId) {
          try { deps.broadcastCostSnapshot(info.project, info.runId); } catch { /* ok */ }
        }
      });
    }

    // ── Feature-flagged checkpoint cache ──
    if (process.env.ANVIL_CHECKPOINTS_ENABLED === '1') {
      // Phase 7 — when ANVIL_CHECKPOINT_SIMILARITY_ENABLED is also set, the
      // lookup falls through to a near-edit similarity match if the exact
      // hash misses. Index files live alongside the per-project checkpoint
      // tree, one instance per project to keep load() linear in that
      // project's history. Default off (per the plan's rollback section).
      const similarityEnabled = process.env.ANVIL_CHECKPOINT_SIMILARITY_ENABLED === '1';
      const similarityThreshold = (() => {
        const raw = Number(process.env.ANVIL_CHECKPOINT_SIMILARITY_THRESHOLD);
        return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.95;
      })();
      const similarityIndices = new Map<string, CheckpointSimilarityIndex>();
      const getSimilarityIndex = (p: string): CheckpointSimilarityIndex => {
        let idx = similarityIndices.get(p);
        if (!idx) {
          idx = new CheckpointSimilarityIndex({ anvilHome: deps.anvilHome, project: p });
          similarityIndices.set(p, idx);
        }
        return idx;
      };

      deps.agentManager.setCheckpointHook({
        lookup: (input) => {
          try {
            const runFamily = input.runFamily ?? 'unknown';
            const stage = input.stage as 'plan'|'implement'|'review'|'test'|'ship';
            const taskId = `${input.persona}:${input.stage}`;
            const promptVersion = '1';
            const key = computeCheckpointKey(runFamily, {
              stage,
              taskId,
              inputs: { prompt: input.prompt },
              promptVersion,
              model: input.model,
            });
            const rec = deps.checkpointStore.get(input.project, runFamily, key);
            if (rec && rec.status === 'completed' && rec.outputRef) {
              const blob = deps.blobStore.read(rec.outputRef);
              if (blob) return { hit: true, output: blob.toString('utf-8') };
            }
            // Phase 7 — fall through to similarity match within the same slot.
            if (similarityEnabled) {
              const vec = embedPrompt(input.prompt);
              const match = getSimilarityIndex(input.project).nearest(
                { runFamily, stage, taskId, model: input.model, promptVersion },
                vec,
                similarityThreshold,
              );
              if (match) {
                const blob = deps.blobStore.read(match.entry.outputRef);
                if (blob) {
                  process.stderr.write(
                    `[checkpoint-similarity] hit project=${input.project} stage=${stage} ` +
                      `taskId=${taskId} score=${match.score.toFixed(4)}\n`,
                  );
                  return { hit: true, output: blob.toString('utf-8') };
                }
              }
            }
          } catch { /* cache miss on error */ }
          return { hit: false };
        },
        record: (input) => {
          try {
            const runFamily = input.runFamily ?? 'unknown';
            const stage = input.stage as 'plan'|'implement'|'review'|'test'|'ship';
            const taskId = `${input.persona}:${input.stage}`;
            const promptVersion = '1';
            const { sha } = deps.blobStore.write(input.output);
            const key = computeCheckpointKey(runFamily, {
              stage,
              taskId,
              inputs: { prompt: input.prompt },
              promptVersion,
              model: input.model,
            });
            deps.checkpointStore.write(input.project, {
              key,
              project: input.project,
              status: 'completed',
              outputRef: sha,
              cost: {
                usd: input.cost.totalUsd,
                tokensIn: input.cost.inputTokens,
                tokensOut: input.cost.outputTokens,
              },
              startedAt: new Date().toISOString(),
              completedAt: new Date().toISOString(),
              durationMs: input.cost.durationMs,
            });
            // Phase 7 — mirror into the similarity index so the next near-edit
            // run can find this output via cosine, not just exact hash.
            if (similarityEnabled) {
              try {
                getSimilarityIndex(input.project).add({
                  runFamily,
                  stage,
                  taskId,
                  model: input.model,
                  promptVersion,
                  vec: embedPrompt(input.prompt),
                  outputRef: sha,
                  hash: key.hash,
                  cost: {
                    usd: input.cost.totalUsd,
                    tokensIn: input.cost.inputTokens,
                    tokensOut: input.cost.outputTokens,
                  },
                  recordedAt: new Date().toISOString(),
                });
              } catch { /* similarity persistence best-effort */ }
            }
          } catch { /* persistence best-effort */ }
        },
      });
    }

    deps.setActivePipelineRunner(runner);

    // Map all pipeline agents to this run ID as they're spawned
    const originalSpawn = deps.agentManager.spawn.bind(deps.agentManager);
    deps.agentManager.spawn = ((config: Parameters<typeof originalSpawn>[0]) => {
      const agent = originalSpawn(config);
      deps.agentToRunId.set(agent.id, pipelineRunId);
      return agent;
    }) as typeof deps.agentManager.spawn;

    // Broadcast pipeline state changes
    runner.on('state-change', (pipelineState: PipelineRunState) => {
      const dashState: DashboardState = {
        activePipeline: {
          runId: pipelineState.runId,
          project: pipelineState.project,
          feature: pipelineState.feature,
          featureSlug: pipelineState.featureSlug,
          status: pipelineState.status as DashboardPipeline['status'],
          currentStage: pipelineState.currentStage,
          stages: pipelineState.stages.map((s) => ({
            name: s.name,
            label: s.label,
            status: s.status,
            startedAt: s.startedAt ?? undefined,
            completedAt: s.completedAt ?? undefined,
            error: s.error ?? undefined,
            cost: s.cost,
            perRepo: s.perRepo,
            repos: s.repos.length > 0 ? s.repos.map((r) => ({
              repoName: r.repoName,
              agentId: r.agentId,
              status: r.status,
              cost: r.cost,
              error: r.error,
            })) : undefined,
            // Phase 8 — surface routing decisions so the UI can show
            // "build → qwen3:14b" badges and 🔒/📝/⚡ permission glyphs.
            resolvedModel: s.resolvedModel,
            permissionClasses: s.permissionClasses,
            // Stage Q&A — agent's `<questions>...</questions>` block parsed
            // into a typed list. PipelineContainer mounts StageQuestionsPanel
            // when this is non-empty. Dropping this field was a silent
            // regression: pipeline-stages.ts populated `s.questions` and
            // emitted `stage-question` events, but the wire-state mapper
            // omitted the field — frontend never got the questions, the
            // answer panel never appeared, the runner sat in
            // `ctx.waitForSignal` forever.
            ...(s.questions && s.questions.length > 0 ? { questions: s.questions } : {}),
          })),
          startedAt: pipelineState.startedAt,
          cost: { inputTokens: 0, outputTokens: 0, estimatedCost: pipelineState.totalCost },
          model: pipelineState.model,
          repoNames: pipelineState.repoNames,
          waitingForInput: pipelineState.waitingForInput,
        },
        lastUpdated: new Date().toISOString(),
      };

      // Write to state.json
      try {
        const tmp = deps.stateFile + '.tmp';
        writeFileSync(tmp, JSON.stringify(dashState, null, 2), 'utf-8');
        renameSync(tmp, deps.stateFile);
      } catch { /* ignore */ }

      // Pipeline-driven update — skip broadcastState's dedup.
      deps.services.system.emit('state', { state: dashState });
    });

    runner.on('waiting-for-input', (stageIndex: number, agentId: string) => {
      deps.services.pipeline.emit('pipeline.waiting-for-input', { stageIndex, agentId });
    });

    // Show clarify questions one at a time
    runner.on('clarify-question', (data: { stageIndex: number; questionIndex: number; totalQuestions: number; question: string }) => {
      const stageName = runner.getState().stages[data.stageIndex]?.name ?? 'clarify';
      const entry: ActivityEntry = {
        timestamp: Date.now(),
        stage: stageName,
        type: 'stdout',
        content: `**Question ${data.questionIndex + 1} of ${data.totalQuestions}:**\n\n${data.question}`,
        kind: 'clarify-question',
      };
      pipelineActivities.push(entry);
      deps.pushOutputEntry(entry);
      deps.services.agents.emit('agent.output', { entries: [entry], runId: pipelineRunId } as never);
    });

    // Show acknowledgment after user answers
    runner.on('clarify-ack', (data: { stageIndex: number; questionIndex: number; totalQuestions: number; hasMore: boolean }) => {
      const stageName = runner.getState().stages[data.stageIndex]?.name ?? 'clarify';
      const msg = data.hasMore
        ? `Got it! Moving to question ${data.questionIndex + 2} of ${data.totalQuestions}...`
        : `All ${data.totalQuestions} questions answered. Synthesizing understanding...`;
      const entry: ActivityEntry = {
        timestamp: Date.now(),
        stage: stageName,
        type: 'stdout',
        content: msg,
        kind: 'clarify-ack',
      };
      pipelineActivities.push(entry);
      deps.pushOutputEntry(entry);
      deps.services.agents.emit('agent.output', { entries: [entry], runId: pipelineRunId } as never);
    });

    // Show user input as a visible entry in the output
    runner.on('user-input', ({ stageIndex, text }: { stageIndex: number; text: string }) => {
      const stageName = runner.getState().stages[stageIndex]?.name ?? 'clarify';
      const entry: ActivityEntry = {
        timestamp: Date.now(),
        stage: stageName,
        type: 'stdout',
        content: text,
        kind: 'user-message',
      };
      pipelineActivities.push(entry);
      deps.pushOutputEntry(entry);
      deps.services.agents.emit('agent.output', { entries: [entry], runId: pipelineRunId } as never);
    });

    // Show pipeline warnings (e.g., missing KB)
    runner.on('warning', (data: { message: string }) => {
      const entry: ActivityEntry = {
        timestamp: Date.now(),
        stage: 'pipeline',
        type: 'stderr',
        content: `⚠️ ${data.message}`,
        kind: 'project',
      };
      pipelineActivities.push(entry);
      deps.pushOutputEntry(entry);
      deps.services.agents.emit('agent.output', { entries: [entry], runId: pipelineRunId } as never);
    });

    // Show integration events (KB injection, project context) in the output panel
    runner.on('project-event', (data: { source: string; message: string; level?: string; stage?: string }) => {
      const prefix = data.source === 'knowledge-base' ? '📚' : data.source === 'project-context' ? '🔌' : 'ℹ️';
      // Tag with the originating pipeline stage when the emitter knows it
      // (KB / project-context events fire during prompt-building for a
      // specific stage). Falls back to 'pipeline' for run-level events
      // (warmup, routing, cost-budget) so they don't get filtered out
      // entirely when no stage is selected.
      const entry: ActivityEntry = {
        timestamp: Date.now(),
        stage: data.stage ?? 'pipeline',
        type: (data.level === 'warn' ? 'stderr' : 'stdout') as 'stderr' | 'stdout',
        content: `${prefix} [${data.source}] ${data.message}`,
        kind: 'project',
      };
      pipelineActivities.push(entry);
      deps.pushOutputEntry(entry);
      deps.services.agents.emit('agent.output', { entries: [entry], runId: pipelineRunId } as never);
    });

    // Auth expired — send browser notification so user knows to re-login
    runner.on('auth-required', (data: { stageName: string; message: string }) => {
      deps.services.pipeline.emit('pipeline.auth-required', {
        runId: pipelineRunId,
        stageName: data.stageName,
        message: data.message,
      });
    });

    // §H3 per-model step cost. Forward the rollup to the typed event surface
    // (CostMeter per-model breakdown) AND, when the step was continued across
    // models, drop a "↪ continued by <successor>" marker into the activity
    // stream. The handoff is read from the rollup's `continuation` summary
    // (burned-vs-completed model sets) — NOT from re-injected token volume or
    // cost — so it fires on the common 429-before-first-delta burn (empty
    // prefill, zero tokens) and for unpriced successors (zero reinjection $).
    runner.on('step-cost', (data: {
      runId: string;
      stepId: string;
      costByModel: Record<string, {
        model: string;
        provider?: string;
        costUsd: number;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheWriteTokens: number;
        prefilledInputTokens: number;
      }>;
      prefillReinjectionUsd: number;
      totalCostUsd: number;
      continuation: { successors: string[]; predecessors: string[] } | null;
    }) => {
      deps.services.pipeline.emit('pipeline.step-cost', data);

      const cont = data.continuation;
      if (cont && cont.successors.length > 0 && cont.predecessors.length > 0) {
        // Only append the re-injection cost when there actually was one (a
        // non-empty prefill priced against a known model).
        const reinjected = data.prefillReinjectionUsd > 0
          ? ` (+$${data.prefillReinjectionUsd.toFixed(4)} re-injected)`
          : '';
        const entry: ActivityEntry = {
          timestamp: Date.now(),
          stage: data.stepId,
          type: 'stdout',
          content: `↪ Continued by ${cont.successors.join(', ')} after ${cont.predecessors.join(', ')} exhausted${reinjected}`,
          kind: 'provenance',
        };
        pipelineActivities.push(entry);
        deps.pushOutputEntry(entry);
        deps.services.agents.emit('agent.output', { entries: [entry], runId: pipelineRunId } as never);
      }
    });

    // Show artifacts in changes tab + scan ship artifacts for PR URLs
    runner.on('artifact-written', (data: { stage: string; file: string; summary: string; content: string; repo?: string }) => {
      // If this is the ship stage artifact, scan for PR URLs and associate with this run
      if (data.stage === 'ship' && data.content) {
        const prUrls = deps.extractPRUrls(data.content);
        const run = deps.activeRuns.get(pipelineRunId);
        for (const url of prUrls) {
          deps.trackPR(url).catch(() => {});
          if (run) run.prUrls.add(url);
        }
      }

      // If the test stage wrote a new spec, push the refreshed list + the new
      // spec itself to every connected client so TestSpecPage swaps in the
      // freshly generated spec instead of the last-loaded one.
      if (data.stage === 'test') {
        try {
          const specs = deps.testSpecStore.listSpecs(project);
          deps.services.tests.emit('test.specs', { specs });
          if (specs.length > 0) {
            const newest = specs[0];
            const spec = deps.testSpecStore.readCurrent(project, newest.slug);
            if (spec) {
              const cases = deps.testCaseStore.readCases(project, spec.slug, spec.version);
              deps.services.tests.emit('test.spec-created', { spec, cases });
            }
          }
        } catch (err) {
          console.warn('[pipeline] test-spec broadcast failed:', err);
        }
      }
      // Two kinds of `artifact-written` flow through here:
      //   1. Real artifacts (REQUIREMENTS.md / SPECS.md / BUILD.md / …)
      //      → data.file is set, summary may be present.
      //   2. Pre-spawn prep progress (auth probe / git branches / lint
      //      guards / "spawning agent…") → data.file is '', data.summary
      //      carries the user-visible status. These light up the
      //      Activity panel during the otherwise-silent setup gap.
      // For (1) we keep the old "Artifact: <file>" label so the existing
      // UI tooltip + Changes-panel wiring stays untouched. For (2) we
      // surface `summary` as the activity content + skip the change entry
      // (no file means nothing to render in Changes).
      const isPrepEvent = !data.file && !!data.summary;
      const entry: ActivityEntry = {
        timestamp: Date.now(),
        stage: data.stage,
        type: 'stdout',
        content: isPrepEvent
          ? data.summary
          : `Artifact: ${data.file}${data.summary ? ` — ${data.summary}` : ''}`,
        kind: isPrepEvent ? 'project' : 'artifact',
        repo: data.repo,
      };
      pipelineActivities.push(entry);
      deps.pushOutputEntry(entry);
      deps.services.agents.emit('agent.output', { entries: [entry], runId: pipelineRunId } as never);
      // Only fan out to Changes panel when an actual file was written.
      if (data.file) {
        deps.services.system.emit('artifact', {
          runId: pipelineRunId,
          stage: data.stage,
          kind: 'file',
          value: {
            file: data.file,
            stage: data.stage,
            summary: data.summary,
            repo: data.repo,
            timestamp: Date.now(),
          },
        });
      }
    });

    runner.on('pipeline-complete', (pipelineState: PipelineRunState) => {
      deps.persistRunRecord(pipelineState, pipelineRunId);
      autoLearn(deps.memoryStore, pipelineState);

      // Auto-review Anvil-authored PRs when the run was plan-seeded.
      // Fire-and-forget; reviews run async and broadcast their own events.
      const completedRunForPrs = deps.activeRuns.get(pipelineRunId);
      const prUrls = completedRunForPrs ? Array.from(completedRunForPrs.prUrls) : [];
      if (prUrls.length && options?.planSeed) {
        const personas: Persona[] = ['architect', 'security', 'tester'];
        for (const prUrl of prUrls) {
          deps.startReviewRun(project, prUrl, 'ship', personas, options?.model)
            .catch((err) => console.warn(`[ship-review] ${prUrl}:`, err?.message ?? err));
        }
      }

      deps.setActivePipelineRunner(null);
      deps.agentManager.spawn = originalSpawn; // restore original spawn
      const completedRun = deps.activeRuns.get(pipelineRunId);
      if (completedRun) completedRun.status = 'completed';
      deps.activeRuns.delete(pipelineRunId);
      detachBus();
      // Lifecycle — pipeline success flips into reconciling → complete.
      if (options?.planSeed) {
        void deps.dispatchLifecycle(project, options.planSeed.slug, { kind: 'execute-complete' });
        // Reconcile is a no-op stub today; advance the state machine.
        void deps.dispatchLifecycle(project, options.planSeed.slug, { kind: 'reconcile-complete' });
      }
      deps.broadcastActiveRuns();
      deps.broadcastRuns();
    });

    runner.on('pipeline-fail', (pipelineState: PipelineRunState) => {
      deps.persistRunRecord(pipelineState, pipelineRunId);
      autoLearn(deps.memoryStore, pipelineState);
      deps.setActivePipelineRunner(null);
      deps.agentManager.spawn = originalSpawn;
      const failedRun = deps.activeRuns.get(pipelineRunId);
      if (failedRun) failedRun.status = 'failed';
      // Keep failed runs in activeRuns — they are resumable and should stay visible
      detachBus();
      // Lifecycle — pipeline failure is terminal for the plan-seeded run.
      if (options?.planSeed) {
        const reason = pipelineState.stages.find((s) => s.error)?.error
          ?? `pipeline failed at stage ${pipelineState.currentStage}`;
        void deps.dispatchLifecycle(project, options.planSeed.slug, { kind: 'execute-failed', reason });
      }
      deps.broadcastActiveRuns();
      deps.broadcastRuns();
    });

    // Run the pipeline (async, non-blocking)
    runner.run().catch((err) => {
      console.error('[dashboard] Pipeline failed:', err);
      deps.setActivePipelineRunner(null);
      detachBus();
    });
  };
}
