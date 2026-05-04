/**
 * `validate` step factory — standalone validate stage callable from the
 * Fix flow (and any future flow that wants a validate pass without the
 * full build pipeline).
 *
 * Behavior parity with `pipeline-runner.ts`'s validate stage:
 *   - Per-repo fan-out when `repoNames.length > 0`, else single-workspace.
 *   - Combines per-repo outputs into one VALIDATE.md artifact.
 *   - Detects failure via `hasValidationFailures` (lifted from fix-loop).
 *   - Persona = 'tester'; allowedTools sourced by the caller.
 */

import { spawnAndWait } from './agent-spawner.js';
import { hasValidationFailures } from './fix-loop.step.js';
import { disallowedToolsForPersona } from './per-repo-stage.step.js';
import type { AgentManager } from '@anvil/agent-core';

export interface RunValidateOptions {
  agentManager: AgentManager;
  project: string;
  /** Resolved model id for the validate stage. */
  model: string;
  workspaceDir: string;
  repoNames: string[];
  repoPaths: Record<string, string>;
  /** Builds the per-repo project (system) prompt. Mirrors fix-loop's hook. */
  buildRepoProjectPrompt: (repoName: string) => string;
  /** Builds the project-wide system prompt for single-workspace path. */
  buildProjectPrompt: () => string;
  isCancelled: () => boolean;
  onTruncation?: (agentName: string, outputTokens: number) => void;
  /** Optional output-token ceiling. */
  maxOutputTokens?: number;
  /** Per-stage allow list. Validate is read+exec only (lint/typecheck/tests). */
  allowedTools?: string[];
  pollIntervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  /** Optional spawn-id sink so the caller can persist for future resume. */
  onSpawn?: (repoName: string | null, agentId: string) => void;
}

export interface RunValidateResult {
  /** Combined VALIDATE.md across all repos. */
  artifact: string;
  /** True when at least one repo failed (or single-workspace mode failed). */
  failed: boolean;
  /** Per-repo outcome — empty for single-workspace mode. */
  perRepo: Record<string, { failed: boolean; section: string }>;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
}

const VALIDATE_PROMPT_REPO = (repoName: string) =>
  `You are validating "${repoName}" for build errors, lint errors, and test failures.\n\n` +
  `Run the project's build / lint / test commands as appropriate. Report each check\n` +
  `as PASS or FAIL with a one-line reason. Do NOT modify any files.\n\n` +
  `Format the output as:\n\n` +
  `## ${repoName}\n` +
  `- Build: PASS | FAIL: <reason>\n` +
  `- Lint: PASS | FAIL: <reason>\n` +
  `- Tests: PASS | FAIL: <reason>\n` +
  `\nVERDICT: PASS | FAIL\n`;

const VALIDATE_PROMPT_SINGLE =
  `Validate the workspace for build errors, lint errors, and test failures.\n\n` +
  `Run the project's build / lint / test commands as appropriate. Report each check\n` +
  `as PASS or FAIL with a one-line reason. Do NOT modify any files.\n\n` +
  `Format the output as:\n\n` +
  `- Build: PASS | FAIL: <reason>\n` +
  `- Lint: PASS | FAIL: <reason>\n` +
  `- Tests: PASS | FAIL: <reason>\n` +
  `\nVERDICT: PASS | FAIL\n`;

export async function runValidate(opts: RunValidateOptions): Promise<RunValidateResult> {
  if (opts.repoNames.length === 0) {
    const result = await spawnAndWait({
      agentManager: opts.agentManager,
      spec: {
        name: `validate-${opts.project}`,
        persona: 'tester',
        project: opts.project,
        stage: 'validate',
        prompt: VALIDATE_PROMPT_SINGLE,
        model: opts.model,
        cwd: opts.workspaceDir,
        projectPrompt: opts.buildProjectPrompt(),
        permissionMode: 'bypassPermissions',
        disallowedTools: disallowedToolsForPersona('tester'),
        allowedTools: opts.allowedTools,
        maxOutputTokens: opts.maxOutputTokens,
      },
      isCancelled: opts.isCancelled,
      onSpawn: (id) => opts.onSpawn?.(null, id),
      onTruncation: opts.onTruncation,
      pollIntervalMs: opts.pollIntervalMs,
      sleep: opts.sleep,
    });
    return {
      artifact: result.artifact,
      failed: hasValidationFailures(result.artifact),
      perRepo: {},
      cost: result.cost,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      cacheReadTokens: result.cacheReadTokens,
      cacheWriteTokens: result.cacheWriteTokens,
    };
  }

  const promises = opts.repoNames.map(async (repoName) => {
    const repoPath = opts.repoPaths[repoName] ?? opts.workspaceDir;
    const result = await spawnAndWait({
      agentManager: opts.agentManager,
      spec: {
        name: `validate-${repoName}`,
        persona: 'tester',
        project: opts.project,
        stage: `validate:${repoName}`,
        prompt: VALIDATE_PROMPT_REPO(repoName),
        model: opts.model,
        cwd: repoPath,
        projectPrompt: opts.buildRepoProjectPrompt(repoName),
        permissionMode: 'bypassPermissions',
        disallowedTools: disallowedToolsForPersona('tester'),
        allowedTools: opts.allowedTools,
        maxOutputTokens: opts.maxOutputTokens,
      },
      isCancelled: opts.isCancelled,
      onSpawn: (id) => opts.onSpawn?.(repoName, id),
      onTruncation: opts.onTruncation,
      pollIntervalMs: opts.pollIntervalMs,
      sleep: opts.sleep,
    });
    return { repoName, ...result };
  });

  const results = await Promise.all(promises);
  const combined = results.map((r) => r.artifact).filter(Boolean).join('\n\n');
  const perRepo: Record<string, { failed: boolean; section: string }> = {};
  for (const r of results) {
    perRepo[r.repoName] = { failed: hasValidationFailures(r.artifact), section: r.artifact };
  }
  return {
    artifact: combined,
    failed: hasValidationFailures(combined),
    perRepo,
    cost: results.reduce((s, r) => s + r.cost, 0),
    inputTokens: results.reduce((s, r) => s + r.inputTokens, 0),
    outputTokens: results.reduce((s, r) => s + r.outputTokens, 0),
    cacheReadTokens: results.reduce((s, r) => s + r.cacheReadTokens, 0),
    cacheWriteTokens: results.reduce((s, r) => s + r.cacheWriteTokens, 0),
  };
}
