/**
 * `AgentManagerSession` — implements `AgentSession` over the dashboard's
 * `AgentManager`. Used by stages that need multi-turn agent semantics
 * (clarify's explore→Q&A→synthesize, fix-loop's iterative fixes).
 *
 * The session id we expose is the same agentId the underlying
 * AgentManager assigns on `spawn()`. `sendInput` calls
 * `agentManager.sendInput(sessionId, text)` which spawns a NEW adapter
 * with `resume:true` against the same session id, then we wait via
 * `waitForAgent`.
 */

import type {
  AgentSession,
  AgentSessionResult,
  AgentRunRequest,
} from '@esankhan3/anvil-core-pipeline';
import type { AgentManager } from '@esankhan3/anvil-agent-core';
import { spawnAndWait, waitForAgent } from '../steps/agent-spawner.js';
import { disallowedToolsForPersona } from '@esankhan3/anvil-core-pipeline';

export interface AgentManagerSessionOptions {
  agentManager: AgentManager;
  project: string;
  workspaceDir: string;
  isCancelled: () => boolean;
  /** Resolves the model to use for the initial spawn. */
  resolveModel: (stageName: string) => string;
  onSpawn?: (agentId: string, req: AgentRunRequest) => void;
  onTruncation?: (agentName: string, outputTokens: number) => void;
}

export class AgentManagerSession implements AgentSession {
  constructor(private readonly opts: AgentManagerSessionOptions) {}

  async start(req: AgentRunRequest): Promise<AgentSessionResult> {
    const model = req.model ?? this.opts.resolveModel(req.stage);
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
      },
      isCancelled: this.opts.isCancelled,
      onSpawn: (agentId) => this.opts.onSpawn?.(agentId, req),
      onTruncation: this.opts.onTruncation,
    });
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

  async sendInput(sessionId: string, text: string): Promise<AgentSessionResult> {
    // Tell AgentManager to feed the message — it spawns a fresh adapter
    // with resume=true and the same sessionId.
    this.opts.agentManager.sendInput(sessionId, text);
    const completed = await waitForAgent({
      agentId: sessionId,
      agentManager: this.opts.agentManager,
      isCancelled: this.opts.isCancelled,
      onTruncation: this.opts.onTruncation,
    });
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

  kill(sessionId: string): void {
    // AgentManager exposes a kill via the adapter chain; if the session
    // is already done, this is a no-op.
    const agent = this.opts.agentManager.getAgent(sessionId);
    if (agent && agent.status === 'running') {
      // Best-effort; AgentManager doesn't expose a public kill method, so
      // we rely on cancellation propagation through isCancelled().
    }
  }
}
