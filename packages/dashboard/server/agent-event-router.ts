/**
 * Agent-event router (Phase 2 / extraction module 2).
 *
 * Subscribes to the 4 events emitted by `AgentManager`:
 *
 *   - `agent-activity`  — structured activity from the model (tool call,
 *                         assistant text, content). Pushed onto the
 *                         output buffer + per-run activity list, emitted
 *                         via `services.agents.emit('agent.output', …)`,
 *                         scanned for PR URLs.
 *   - `agent-output`    — raw stdout chunks; we only forward the
 *                         `> User:` echo lines (from `sendInput`) so the
 *                         output panel shows what the operator typed.
 *   - `agent-done`      — agent process exited cleanly. Plan-agent +
 *                         review-agent post-processing fires; for
 *                         non-pipeline runs, persist a `RUNS_INDEX`
 *                         record and clean up the active-run row.
 *   - `agent-error`     — the agent failed. Same active-run reap as
 *                         `agent-done` (for non-pipeline-build runs)
 *                         plus the plan-agent chain-walker retry path.
 *
 * Used to live inline at the top of `startDashboardServer`. Lifted out
 * so the registry handlers (and future test scaffolding) can poke at
 * the agent lifecycle without re-implementing the post-processing
 * chain. The attach is now wired late — after all closure deps (e.g.
 * `finalizePlanAgent`, `retryPlanAgentWithNextModel`) are declared —
 * so the deps bag can capture concrete function references.
 *
 * Returns a `detach()` cleanup fn so tests can release the listeners.
 */

import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import type { AgentManager, AgentState } from '@esankhan3/anvil-agent-core';
import type { PipelineRunner } from './pipeline-runner.js';
import type { DashboardServices } from './services/index.js';
import type { ActivityEntry, ActiveRun } from './broadcasts.js';

/** Minimal shape of the active-run + agent-mapping state the router pokes. */
export interface AgentEventRouterDeps {
  agentManager: AgentManager;
  /** Shared output buffer — every activity gets pushed here for re-init replay. */
  outputBuffer: ActivityEntry[];
  /** Run registry — read/write. */
  activeRuns: Map<string, ActiveRun>;
  /** Agent ID → run ID map (quick-action agents). */
  agentToRunId: Map<string, string>;
  /** Typed event services. */
  services: DashboardServices;
  /** `<anvilHome>/runs` and `<anvilHome>/runs/index.jsonl` — for persistence. */
  runsDir: string;
  runsIndex: string;
  /**
   * Reader for the live pipeline runner. The agent-event-router needs to
   * detect whether a finishing agent belongs to a pipeline (in which
   * case the pipeline-runner owns the run lifecycle) or a one-shot
   * quick-action (in which case we persist + reap here). The runner is
   * a `let`-bound closure so we accept a getter, not a snapshot.
   */
  getActivePipelineRunner: () => PipelineRunner | null;
  /** PR-URL extraction + tracking (closures over the PR cache). */
  extractPRUrls: (text: string) => string[];
  trackPR: (url: string) => Promise<void>;
  /** Plan-agent post-processing — parses the JSON, persists, broadcasts. */
  finalizePlanAgent: (agentId: string, output: string) => void;
  /** Review-agent post-processing. */
  finalizeReviewAgent: (agentId: string, agent: AgentState) => Promise<void>;
  /**
   * Chain-walker retry for failed plan agents. Returns `true` if the
   * router should swallow the error (next sibling model is being tried).
   */
  retryPlanAgentWithNextModel: (
    ctx: PlanAgentContext,
    reason: string,
  ) => Promise<boolean>;
  /** Closure-bound plan-agent context map. */
  planAgentContext: Map<string, PlanAgentContext>;
  /** Broadcast helpers — keep the wire shape unchanged. */
  broadcastRuns: () => void;
  broadcastActiveRuns: () => void;
}

/**
 * Shape of a plan-agent context entry. Mirrors the inline type in
 * `dashboard-server.ts`; kept loose because the dashboard owns the
 * canonical type and we only need to forward the value here.
 */
export interface PlanAgentContext {
  project: string;
  feature: string;
  model: string;
  // …additional fields owned by `dashboard-server.ts`; widened for
  // forward-compat.
  [k: string]: unknown;
}

/**
 * Attach the 4 listeners. Returns a `detach()` fn that removes them all
 * — used by tests and graceful shutdown.
 */
export function attachAgentEventRouter(deps: AgentEventRouterDeps): () => void {
  const {
    agentManager, outputBuffer, activeRuns, agentToRunId, services,
    runsDir, runsIndex, getActivePipelineRunner, extractPRUrls, trackPR,
    finalizePlanAgent, finalizeReviewAgent, retryPlanAgentWithNextModel,
    planAgentContext, broadcastRuns, broadcastActiveRuns,
  } = deps;

  function resolveAgentRepo(agentId: string): string | undefined {
    const runner = getActivePipelineRunner();
    if (!runner) return undefined;
    const state = runner.getState();
    for (const stage of state.stages) {
      for (const repo of stage.repos) {
        if (repo.agentId === agentId) return repo.repoName;
      }
    }
    return undefined;
  }

  function resolveAgentStage(agentId: string): string | undefined {
    const runner = getActivePipelineRunner();
    if (!runner) return undefined;
    const state = runner.getState();
    for (const stage of state.stages) {
      if (stage.agentId === agentId) return stage.name;
      for (const repo of stage.repos) {
        if (repo.agentId === agentId) return stage.name;
      }
    }
    return undefined;
  }

  // Structured activities — full content (not just summary) lands on the
  // wire so downstream Tools / Files panels render the same data the
  // model produced.
  const onActivity = ({ agentId, activity }: { agentId: string; activity: {
    timestamp: number; content?: string; summary?: string; kind?: string; tool?: string;
  } }): void => {
    const repo = resolveAgentRepo(agentId);
    const stage = resolveAgentStage(agentId);
    const entry: ActivityEntry = {
      timestamp: activity.timestamp,
      stage: stage || 'agent',
      type: 'stdout',
      content: (activity.content ?? activity.summary) ?? '',
      kind: activity.kind,
      tool: activity.tool,
      agentId,
      repo,
    };
    outputBuffer.push(entry);

    const runId = agentToRunId.get(agentId);
    if (runId) {
      const run = activeRuns.get(runId);
      if (run) run.activities.push(entry);
    }

    services.agents.emit('agent.output', { entries: [entry] as never, runId });

    // PR-URL scan — track them per-run for the history panel.
    const content = activity.content ?? activity.summary ?? '';
    const prUrls = extractPRUrls(content);
    if (prUrls.length > 0) {
      const run = runId ? activeRuns.get(runId) : null;
      for (const url of prUrls) {
        trackPR(url).catch(() => { /* tracker is best-effort */ });
        if (run) run.prUrls.add(url);
      }
    }
  };

  // Only forward `> User:` echo lines from `sendInput`; the rest of the
  // raw chunks duplicate the structured activity stream.
  const onOutput = ({ agentId, chunk }: { agentId: string; chunk: string }): void => {
    if (!chunk.includes('> User:')) return;
    const stage = resolveAgentStage(agentId);
    const entry: ActivityEntry = {
      timestamp: Date.now(),
      stage: stage || 'agent',
      type: 'stdout',
      content: chunk.trim(),
      kind: 'user-message',
      agentId,
    };
    outputBuffer.push(entry);
    services.agents.emit('agent.output', { entries: [entry] as never });
  };

  const onDone = ({ agent }: { agent: AgentState }): void => {
    services.agents.emit('agent.done', { agentId: agent.id, agent });

    // Plan-agent / review-agent post-processing. These swallow their own
    // errors — broadcast already happened inside.
    try { finalizePlanAgent(agent.id, (agent.finalAnswer || agent.output) ?? ''); } catch { /* ok */ }
    void finalizeReviewAgent(agent.id, agent).catch(() => { /* ok */ });

    // Persist + reap one-shot runs. Pipeline `build` agents are owned by
    // the pipeline runner's lifecycle — leave those alone.
    const runId = agentToRunId.get(agent.id);
    const activeRun = runId ? activeRuns.get(runId) : null;
    if (!activeRun) return;

    if (activeRun.type === 'build' && getActivePipelineRunner()) {
      agentToRunId.delete(agent.id);
      return;
    }

    activeRun.status = agent.status === 'done' ? 'completed' : 'failed';

    const runRecord = {
      id: activeRun.id,
      project: activeRun.project,
      feature: activeRun.description,
      featureSlug: '',
      status: activeRun.status,
      model: activeRun.model,
      type: activeRun.type,
      createdAt: new Date(activeRun.startedAt).toISOString(),
      updatedAt: new Date().toISOString(),
      durationMs: Date.now() - activeRun.startedAt,
      totalCost: agent.cost.totalUsd,
      repoNames: [],
      prUrls: [],
      stages: [{
        name: activeRun.type,
        label: activeRun.type === 'fix' ? 'Bug Fix' : 'Research',
        status: activeRun.status,
        cost: agent.cost.totalUsd,
        startedAt: new Date(activeRun.startedAt).toISOString(),
        completedAt: new Date().toISOString(),
        error: agent.error,
        repos: [],
      }],
      // Persist the canonical artifact (finalAnswer); fall back to raw
      // output for legacy paths without a structured result.
      output: (agent.finalAnswer || agent.output)?.slice(0, 50000) ?? '',
    };

    try {
      if (!existsSync(runsDir)) mkdirSync(runsDir, { recursive: true });
      appendFileSync(runsIndex, JSON.stringify(runRecord) + '\n', 'utf-8');
    } catch { /* history is best-effort */ }

    broadcastRuns();
    broadcastActiveRuns();

    activeRuns.delete(activeRun.id);
    agentToRunId.delete(agent.id);
    broadcastActiveRuns();
  };

  const onError = ({ agentId, error }: { agentId: string; error: string }): void => {
    const stage = resolveAgentStage(agentId);
    const errorEntry: ActivityEntry = {
      timestamp: Date.now(),
      stage: stage || 'agent',
      type: 'stderr',
      content: `Error: ${error}`,
      kind: 'stderr',
      agentId,
    };
    outputBuffer.push(errorEntry);
    services.agents.emit('agent.output', { entries: [errorEntry] as never });
    services.agents.emit('agent.error', { agentId, error });

    // Reap the failed agent's active-run row. Pipeline `build` runs are
    // owned by the pipeline runner — see `onDone` above for the matching
    // early return. Without the reap, plan agents that hit `agent-error`
    // (silent-empty, 429 stall, upstream 5xx) leave a permanent
    // `status: 'running'` row in the UI.
    const failedRunId = agentToRunId.get(agentId);
    if (failedRunId) {
      const failedRun = activeRuns.get(failedRunId);
      const isPipelineBuild = failedRun?.type === 'build' && getActivePipelineRunner();
      if (failedRun && !isPipelineBuild) {
        failedRun.status = 'failed';
        const runRecord = {
          id: failedRun.id,
          project: failedRun.project,
          feature: failedRun.description,
          featureSlug: '',
          status: 'failed' as const,
          model: failedRun.model,
          type: failedRun.type,
          createdAt: new Date(failedRun.startedAt).toISOString(),
          updatedAt: new Date().toISOString(),
          durationMs: Date.now() - failedRun.startedAt,
          totalCost: 0,
          repoNames: [],
          prUrls: [],
          stages: [{
            name: failedRun.type,
            label: failedRun.type,
            status: 'failed' as const,
            cost: 0,
            startedAt: new Date(failedRun.startedAt).toISOString(),
            completedAt: new Date().toISOString(),
            error: String(error).slice(0, 500),
            repos: [],
          }],
          output: '',
        };
        try {
          if (!existsSync(runsDir)) mkdirSync(runsDir, { recursive: true });
          appendFileSync(runsIndex, JSON.stringify(runRecord) + '\n', 'utf-8');
        } catch { /* history is best-effort */ }
        broadcastRuns();
      }
      if (!isPipelineBuild) {
        activeRuns.delete(failedRunId);
        agentToRunId.delete(agentId);
        broadcastActiveRuns();
      }
    }

    // Plan-agent chain-walker retry. Applied at the event level since
    // plan agents don't go through `runWithChainFallback` (which lives
    // on the awaitable `spawnAndWait` path).
    const planCtx = planAgentContext.get(agentId);
    if (planCtx) {
      planAgentContext.delete(agentId);
      void retryPlanAgentWithNextModel(planCtx, `agent-error: ${String(error).slice(0, 120)}`).then((retried) => {
        if (!retried) {
          services.plans.emit('plan.error', {
            project: planCtx.project,
            message: `Plan agent failed: ${String(error).slice(0, 200)}`,
          });
        }
      });
    }
  };

  agentManager.on('agent-activity', onActivity);
  agentManager.on('agent-output', onOutput);
  agentManager.on('agent-done', onDone);
  agentManager.on('agent-error', onError);

  return function detach(): void {
    try { agentManager.off('agent-activity', onActivity); } catch { /* ok */ }
    try { agentManager.off('agent-output', onOutput); } catch { /* ok */ }
    try { agentManager.off('agent-done', onDone); } catch { /* ok */ }
    try { agentManager.off('agent-error', onError); } catch { /* ok */ }
  };
}
