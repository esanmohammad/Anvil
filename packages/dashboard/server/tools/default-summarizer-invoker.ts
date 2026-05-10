/**
 * Default summarizer invoker — uses `runWithAgent` from agent-core to
 * spawn a single-shot agent for the focused summarization call. Routes
 * through the standard adapter factory + provider registry, so any
 * model registered in `~/.anvil/models.yaml` works.
 *
 * The invoker is the seam between the prompt-engineering layer
 * (summarizer.ts) and the model-execution layer (agent-core). Tests
 * substitute their own deterministic stub.
 */

import { randomUUID } from 'node:crypto';
import { runWithAgent } from '@esankhan3/anvil-agent-core';
import type { SummarizerInvocation, SummarizerInvoker } from './summarizer.js';

export function createDefaultSummarizerInvoker(): SummarizerInvoker {
  return async (req: SummarizerInvocation): Promise<string> => {
    const result = await runWithAgent({
      name: 'web-summarizer',
      project: 'web-summarizer',
      runId: `web-summarizer-${randomUUID()}`,
      // The summarizer never reads/writes files — but every adapter
      // wants a workspace to discover skills/MCP. Empty string opts out.
      workspaceDir: '',
      cwd: process.cwd(),
      model: req.model,
      prompt: req.userPrompt,
      projectPrompt: req.systemPrompt,
      stage: req.stage,
      persona: 'summarizer',
      allowedTools: req.allowedTools,
      disallowedTools: ['*'],
      maxOutputTokens: req.maxOutputTokens,
    });
    return result.output;
  };
}
