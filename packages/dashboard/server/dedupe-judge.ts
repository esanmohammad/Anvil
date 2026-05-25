/**
 * Dedupe judge — adapts memory-core's `DedupeJudge` contract onto the
 * dashboard's `AgentManager`. Spawned only when sleeptime ratification
 * encounters a near-duplicate above the similarity threshold; below the
 * threshold or on exact-digest match, memory-core fast-paths and the
 * judge is never invoked. Bounded cost: ~5-10 invocations / day / project.
 *
 * Routes through stage-policy's `dedupe-judge` chain so operators can
 * pin a cheap model. Falls back through `pickAliveModelFromChainSync`
 * when the primary is down. Throws into memory-core's `.catch()` which
 * degrades to `add` (preserving the proposal as fresh rather than losing it).
 */

import type { AgentManager, ProviderName } from '@esankhan3/anvil-agent-core';
import {
  DEDUPE_JUDGE_SYSTEM_PROMPT,
  parseDedupeJudgeOutput,
  type DedupeJudge,
} from '@esankhan3/anvil-memory-core';
import { resolveModelForStage, allowedToolsForStage } from '@esankhan3/anvil-core-pipeline';
import { pickAliveModelFromChainSync } from './provider-liveness.js';
import { resolveProviderForModel } from './provider-registry.js';

// Reuse the reflection chain — both are short-distillation calls that
// benefit from the cheapest available model. A dedicated `dedupe-judge`
// stage in stage-policy.yaml can override later if the cost profile
// diverges.
const JUDGE_STAGE = 'reflection';

export interface CreateDedupeJudgeOptions {
  agentManager: AgentManager;
  project: string;
  cwd: string;
  /** Per-call timeout. Judge calls are <8s with Haiku. 30s is generous. */
  timeoutMs?: number;
}

export function createDedupeJudge(opts: CreateDedupeJudgeOptions): DedupeJudge {
  return async ({ candidate, existing, similarity }) => {
    const chain = resolveModelForStage(JUDGE_STAGE);
    const picked = pickAliveModelFromChainSync(chain, (modelId) => {
      const provider = resolveProviderForModel(modelId);
      return (provider ?? 'claude') as ProviderName;
    });

    const userPrompt = [
      `## CANDIDATE (proposed memory)`,
      `kind: ${candidate.kind}${candidate.subtype ? `:${candidate.subtype}` : ''}`,
      `content: ${typeof candidate.content === 'string' ? candidate.content : JSON.stringify(candidate.content)}`,
      ``,
      `## EXISTING (already stored)`,
      `kind: ${existing.kind}${existing.subtype ? `:${existing.subtype}` : ''}`,
      `content: ${typeof existing.content === 'string' ? existing.content : JSON.stringify(existing.content)}`,
      ``,
      `## Token similarity: ${similarity.toFixed(2)}`,
      ``,
      `Return STRICT JSON: {"verdict": "same"|"superseded"|"unrelated", "reason": "..."}`,
    ].join('\n');

    const agent = opts.agentManager.spawn({
      name: `dedupe-judge`,
      persona: 'reflector',
      project: opts.project,
      stage: JUDGE_STAGE,
      prompt: userPrompt,
      projectPrompt: DEDUPE_JUDGE_SYSTEM_PROMPT,
      model: picked.model,
      cwd: opts.cwd,
      permissionMode: 'bypassPermissions',
      allowedTools: allowedToolsForStage(JUDGE_STAGE), // [] — distillation only
      timeoutMs: opts.timeoutMs ?? 30_000,
    });

    const raw = await waitForOutput(opts.agentManager, agent.id);
    return parseDedupeJudgeOutput(raw);
  };
}

function waitForOutput(agentManager: AgentManager, agentId: string): Promise<string> {
  return new Promise((resolve) => {
    const poll = () => {
      const current = agentManager.getAgent(agentId);
      if (!current) return resolve('');
      if (current.status === 'done' || current.status === 'error' || current.status === 'killed') {
        return resolve(current.output ?? '');
      }
      setTimeout(poll, 250);
    };
    poll();
  });
}
