/**
 * `fix` step factory — runs an engineer agent against a bug
 * description. Composes with the `validate` and `fix-loop` steps to
 * form the multi-stage Fix flow that replaces the prior single-agent
 * `run-fix` quick action.
 *
 * Per-repo fan-out when `repoNames.length > 0`, else single-workspace.
 */

import { spawnAndWait } from './agent-spawner.js';
import { disallowedToolsForPersona } from './per-repo-stage.step.js';
import type { AgentManager } from '@anvil/agent-core';

export interface RunFixOptions {
  agentManager: AgentManager;
  project: string;
  /** Bug description from the user — becomes the agent's prompt. */
  description: string;
  /** Resolved model id for the fix stage. */
  model: string;
  workspaceDir: string;
  repoNames: string[];
  repoPaths: Record<string, string>;
  /** Builds the project (system) prompt. */
  buildProjectPrompt: () => string;
  /** Builds the per-repo project (system) prompt. */
  buildRepoProjectPrompt: (repoName: string) => string;
  isCancelled: () => boolean;
  onTruncation?: (agentName: string, outputTokens: number) => void;
  maxOutputTokens?: number;
  /** Per-stage allow list. Fix needs read+write+exec. */
  allowedTools?: string[];
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Spawn-id sink so callers can track the agent for resume. */
  onSpawn?: (repoName: string | null, agentId: string) => void;
}

export interface RunFixResult {
  /** Combined fix output across all repos (single-workspace: that one agent's output). */
  artifact: string;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Per-repo agent ids — used by fix-loop to resume sessions on retry. */
  agentIds: Map<string, string>;
  /** Single-workspace agent id (null on per-repo path). */
  singleAgentId: string | null;
}

const SHARED_PROMPT_HEADER =
  `Diagnose and fix the bug described below. Apply the minimal change that\n` +
  `resolves the issue. Run the relevant tests to confirm the fix. Do NOT make\n` +
  `git commits — the validate stage will check your work, and a follow-up\n` +
  `stage handles git operations if any are needed.\n\n`;

export async function runFix(opts: RunFixOptions): Promise<RunFixResult> {
  if (opts.repoNames.length === 0) {
    const prompt = `${SHARED_PROMPT_HEADER}Bug:\n${opts.description}`;
    let singleAgentId: string | null = null;
    const result = await spawnAndWait({
      agentManager: opts.agentManager,
      spec: {
        name: `fix-${opts.project}`,
        persona: 'engineer',
        project: opts.project,
        stage: 'fix',
        prompt,
        model: opts.model,
        cwd: opts.workspaceDir,
        projectPrompt: opts.buildProjectPrompt(),
        permissionMode: 'bypassPermissions',
        disallowedTools: disallowedToolsForPersona('engineer'),
        allowedTools: opts.allowedTools,
        maxOutputTokens: opts.maxOutputTokens,
      },
      isCancelled: opts.isCancelled,
      onSpawn: (id) => { singleAgentId = id; opts.onSpawn?.(null, id); },
      onTruncation: opts.onTruncation,
      pollIntervalMs: opts.pollIntervalMs,
      sleep: opts.sleep,
    });
    return {
      artifact: result.artifact,
      cost: result.cost,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheWriteTokens: result.cacheWriteTokens,
      agentIds: new Map(),
      singleAgentId,
    };
  }

  const agentIds = new Map<string, string>();

  const promises = opts.repoNames.map(async (repoName) => {
    const repoPath = opts.repoPaths[repoName] ?? opts.workspaceDir;
    const prompt =
      `${SHARED_PROMPT_HEADER}Target repo: "${repoName}"\n\nBug:\n${opts.description}\n\n` +
      `Stay within the bounds of this repository.`;
    const result = await spawnAndWait({
      agentManager: opts.agentManager,
      spec: {
        name: `fix-${repoName}`,
        persona: 'engineer',
        project: opts.project,
        stage: `fix:${repoName}`,
        prompt,
        model: opts.model,
        cwd: repoPath,
        projectPrompt: opts.buildRepoProjectPrompt(repoName),
        permissionMode: 'bypassPermissions',
        disallowedTools: disallowedToolsForPersona('engineer'),
        allowedTools: opts.allowedTools,
        maxOutputTokens: opts.maxOutputTokens,
      },
      isCancelled: opts.isCancelled,
      onSpawn: (id) => { agentIds.set(repoName, id); opts.onSpawn?.(repoName, id); },
      onTruncation: opts.onTruncation,
      pollIntervalMs: opts.pollIntervalMs,
      sleep: opts.sleep,
    });
    return { repoName, ...result };
  });

  const results = await Promise.all(promises);
  const combined = results
    .map((r) => `## ${r.repoName}\n\n${r.artifact}`)
    .join('\n\n');
  return {
    artifact: combined,
    cost: results.reduce((s, r) => s + r.cost, 0),
    inputTokens: results.reduce((s, r) => s + r.inputTokens, 0),
    outputTokens: results.reduce((s, r) => s + r.outputTokens, 0),
    cacheReadTokens: results.reduce((s, r) => s + r.cacheReadTokens, 0),
    cacheWriteTokens: results.reduce((s, r) => s + r.cacheWriteTokens, 0),
    agentIds,
    singleAgentId: null,
  };
}
