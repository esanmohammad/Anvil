/**
 * `validate` step factory — standalone validate stage.
 *
 * Phase H2 — promoted from
 * `packages/dashboard/server/steps/validate.step.ts` into
 * `core-pipeline/src/steps`. Refactored to take an `AgentRunner` (the
 * canonical agent invocation surface) instead of `AgentManager`. The
 * dashboard's `AgentManagerRunner` satisfies `AgentRunner` so the
 * concrete behavior (chain-fallback walker, persona-specific
 * disallowedTools, permissionMode) lives there; this Step factory
 * stays substrate-agnostic.
 *
 * Behaviour parity:
 *   - Per-repo fan-out when `repoNames.length > 0`, else single-workspace.
 *   - Combines per-repo outputs into one VALIDATE.md artifact.
 *   - Detects failure via `hasValidationFailures` (also exported here so
 *     fix-loop + pipeline-runner can share one heuristic).
 *   - Persona = 'tester'; allowedTools sourced by the caller.
 */

import type { AgentRunner } from '../agent-runner.js';

// ── Pure validation helpers (lifted from fix-loop.step.ts) ───────────

/**
 * Detect validation failures in an artifact. Verbatim from
 * `pipeline-runner.ts:hasValidationFailures()` — kept canonical here so
 * validate.step + fix-loop.step + pipeline-runner all read the same regex.
 */
export function hasValidationFailures(artifact: string): boolean {
  if (!artifact) return false;
  if (/VERDICT:\s*FAIL/i.test(artifact)) return true;
  if (/\bUNRESOLVED\b/i.test(artifact)) return true;

  for (const rawLine of artifact.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/\bPASS\b/.test(line) && !/\bFAIL\b/.test(line)) continue;
    if (/\b(?:build|lint|linting|typecheck|type[- ]?check|tests?)\s+(?:failed|failing|errored|broken|has\s+errors?|exits?\s+non-?zero)\b/i.test(line)) return true;
    if (/(?:^|\s)(?:✗|✖|❌|FAILED:|FAIL:)/.test(line)) return true;
    if (/\b[1-9]\d*\s+(?:failed|failing)\b/i.test(line)) return true;
  }
  return false;
}

/** Extract the section of a combined VALIDATE.md belonging to a specific repo. */
export function extractRepoSection(artifact: string, repoName: string): string {
  const regex = new RegExp(`## ${repoName}[\\s\\S]*?(?=## \\w|$)`, 'i');
  const match = artifact.match(regex);
  if (match) return match[0];
  if (artifact.includes(repoName)) return artifact;
  return '';
}

// ── Step interface ────────────────────────────────────────────────────

export interface RunValidateOptions {
  /** Canonical agent invocation surface — dashboard injects `AgentManagerRunner`. */
  runner: AgentRunner;
  project: string;
  /** Resolved model id. */
  model: string;
  workspaceDir: string;
  repoNames: string[];
  repoPaths: Record<string, string>;
  /** Builds the per-repo project (system) prompt. */
  buildRepoProjectPrompt: (repoName: string) => string;
  /** Builds the project-wide system prompt for single-workspace path. */
  buildProjectPrompt: () => string;
  /** Optional output-token ceiling. */
  maxOutputTokens?: number;
  /** Per-stage allow list. Validate is read+exec only (lint/typecheck/tests). */
  allowedTools?: string[];
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
    const result = await opts.runner.run({
      persona: 'tester',
      stage: 'validate',
      projectPrompt: opts.buildProjectPrompt(),
      userPrompt: VALIDATE_PROMPT_SINGLE,
      workingDir: opts.workspaceDir,
      model: opts.model,
      allowedTools: opts.allowedTools,
      maxOutputTokens: opts.maxOutputTokens,
    });
    return {
      artifact: result.output,
      failed: hasValidationFailures(result.output),
      perRepo: {},
      cost: result.costUsd ?? 0,
      inputTokens: result.inputTokens ?? 0,
      outputTokens: result.outputTokens ?? 0,
      cacheReadTokens: result.cacheReadTokens ?? 0,
      cacheWriteTokens: result.cacheWriteTokens ?? 0,
    };
  }

  const promises = opts.repoNames.map(async (repoName) => {
    const repoPath = opts.repoPaths[repoName] ?? opts.workspaceDir;
    const result = await opts.runner.run({
      persona: 'tester',
      stage: 'validate',
      repoName,
      projectPrompt: opts.buildRepoProjectPrompt(repoName),
      userPrompt: VALIDATE_PROMPT_REPO(repoName),
      workingDir: repoPath,
      model: opts.model,
      allowedTools: opts.allowedTools,
      maxOutputTokens: opts.maxOutputTokens,
    });
    return {
      repoName,
      artifact: result.output,
      cost: result.costUsd ?? 0,
      inputTokens: result.inputTokens ?? 0,
      outputTokens: result.outputTokens ?? 0,
      cacheReadTokens: result.cacheReadTokens ?? 0,
      cacheWriteTokens: result.cacheWriteTokens ?? 0,
    };
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
