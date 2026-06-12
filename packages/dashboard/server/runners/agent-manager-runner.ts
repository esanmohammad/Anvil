/**
 * `AgentManagerRunner` — adapter that satisfies the canonical
 * `AgentRunner` interface (from `@esankhan3/anvil-core-pipeline`)
 * by wrapping the dashboard's heavyweight `AgentManager` + the
 * `spawnAndWait` helper + the chain-fallback walker.
 *
 * Once `pipeline-runner.ts` migrates to driving `Pipeline.run()` over
 * an `InMemoryStepRegistry` (R7), every Step factory will accept this
 * runner as the agent invocation surface. cli builds its own
 * lightweight runner that fulfills the same shape, so the same Step
 * factories drive both consumers without modification.
 */

import type {
  AgentRunner,
  AgentRunRequest,
  AgentRunResult,
} from '@esankhan3/anvil-core-pipeline';
import type { AgentManager, Prefill, ErrorClass } from '@esankhan3/anvil-agent-core';
import { getAgentReliabilityRouter } from '@esankhan3/anvil-agent-core';
import { spawnAndWait } from '../steps/agent-spawner.js';
import { disallowedToolsForPersona } from '@esankhan3/anvil-core-pipeline';

export interface AgentManagerRunnerOptions {
  agentManager: AgentManager;
  /** Project name forwarded to the spawn config. */
  project: string;
  /** Workspace root used as default cwd when the request omits one. */
  workspaceDir: string;
  /** Cancellation predicate read on every poll tick. */
  isCancelled: () => boolean;
  /**
   * Resolves the next model to try given the in-flight burn-set. Lets
   * the dashboard plug in its liveness-aware
   * `pickAliveModelFromChainSync` while the runner stays generic.
   */
  resolveModel: (stageName: string, exclude: ReadonlySet<string>) => string;
  /** Mutable burn-set shared across all stages of a single run. */
  burnedModels: Set<string>;
  /** Max chain-fallback attempts. Forwarded to `LlmRouter.runAgent`. */
  maxAttempts: number;
  /** Optional callback fired the moment an agent is spawned. */
  onSpawn?: (agentId: string, req: AgentRunRequest) => void;
  /** Optional callback fired when the adapter reports max-tokens truncation. */
  onTruncation?: (agentName: string, outputTokens: number) => void;
  /** Optional callback fired when a model gets burned mid-run. */
  onBurn?: (info: {
    stageName: string;
    model: string;
    status: number | string;
    message: string;
    errorClass: ErrorClass;
    delayMs: number;
  }) => void;
  /**
   * Wave 5 — optional callback that powers the agent's `recall_memory`
   * tool. When set AND the stage's permissions include `recall`, the
   * BuiltinToolExecutor advertises the tool to the model. The callback
   * is bounded by a 3-call budget per spawn enforced inside the executor.
   */
  recallMemory?: (
    query: string,
    opts: { kind?: string; subtype?: string; limit?: number },
  ) => Promise<string>;
}

export class AgentManagerRunner implements AgentRunner {
  constructor(private readonly opts: AgentManagerRunnerOptions) {}

  async run(req: AgentRunRequest): Promise<AgentRunResult> {
    // Reliability (chain fallback + per-error-class backoff + circuit breaker
    // + unified classify) is owned by the shared LlmRouter. The model walk
    // stays liveness-aware via the injected `resolveModel`; durable
    // cross-vendor continuation flows through `resolvePrefill` exactly as
    // before. Replaces the old `runWithChainFallback` (which had no backoff
    // or breaker — the gap that let one transient `fetch failed` kill a run).
    const { result } = await getAgentReliabilityRouter().runAgent<AgentRunResult, Prefill>(
      {
        stage: req.stage,
        maxAttempts: this.opts.maxAttempts,
        resolveModel: (excluded) => this.opts.resolveModel(req.stage, excluded),
        onBurn: (info) => {
          this.opts.burnedModels.add(info.model);
          this.opts.onBurn?.(info);
        },
        resolvePrefill: req.resolvePrefill,
      },
      async (model, prefill) => this.spawnOnce(req, model, prefill),
    );
    return result;
  }

  private async spawnOnce(
    req: AgentRunRequest,
    model: string,
    prefill?: AgentRunRequest['prefill'],
  ): Promise<AgentRunResult> {
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
        recallMemory: this.opts.recallMemory,
        // Turn-level durable resume envelope (v2 ADR §2.5/§2.3).
        // turnRecorder stays undefined until the per-stage cutover
        // (H3) builds one from ctx.effect; prefill flows from the
        // chain walker when resolvePrefill is wired. Use the
        // walker-supplied `prefill` ONLY — do NOT `?? req.prefill`:
        // when resolvePrefill throws, the walker intentionally hands
        // `undefined` for a clean retry, and falling back to a stale
        // request-seeded prefill would resurrect an already-burned one.
        turnRecorder: req.turnRecorder,
        prefill,
      },
      isCancelled: this.opts.isCancelled,
      onSpawn: (agentId) => this.opts.onSpawn?.(agentId, req),
      onTruncation: this.opts.onTruncation,
    });

    return {
      output: result.artifact,
      tokenEstimate: (result.inputTokens ?? 0) + (result.outputTokens ?? 0),
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheWriteTokens: result.cacheWriteTokens,
      costUsd: result.cost,
      model,
    };
  }
}
