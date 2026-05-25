/**
 * Parse a `FeatureScope` decision from the requirements stage's
 * artifact. The prompt (see `steps/prompt-builders.ts:requirements`)
 * asks the LLM to append a fenced JSON block with `targetRepos` and
 * `rationale`. This module finds it, validates strictly, and returns
 * `null` for ANY failure mode so the caller falls back to the
 * historical "every repo runs" default.
 *
 * Failure modes that all collapse to `null`:
 *   - No fenced ```json block in the artifact
 *   - JSON parse failure
 *   - `targetRepos` missing / not an array / empty / contains a name
 *     not in `availableRepos` (case-sensitive)
 *   - `rationale` missing / not a string / empty / too long (>500)
 *   - `targetRepos` equals `availableRepos` (treated as "no scoping")
 *
 * Returning `null` is the safe escape hatch. The caller logs a warning
 * but the pipeline proceeds with every repo, matching pre-feature
 * behavior.
 */

import type { FeatureScope } from './types.js';

const MAX_RATIONALE_LEN = 500;

/**
 * Extract the LAST fenced ```json block from a markdown body.
 * The "last" rule matters because the requirements artifact may
 * contain example JSON snippets earlier in the prose; the scope
 * block is by-contract the trailing fence.
 */
function extractLastJsonFence(body: string): string | null {
  // Non-greedy fenced block, optional newline before/after braces.
  const re = /```json\s*([\s\S]*?)```/g;
  let last: string | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    last = m[1].trim();
  }
  return last;
}

export function parseFeatureScope(
  requirementsArtifact: string,
  availableRepos: readonly string[],
): FeatureScope | null {
  if (!requirementsArtifact || availableRepos.length === 0) return null;

  const fenced = extractLastJsonFence(requirementsArtifact);
  if (!fenced) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fenced);
  } catch {
    return null;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;

  const targetRepos = obj.targetRepos;
  const rationale = obj.rationale;

  if (!Array.isArray(targetRepos) || targetRepos.length === 0) return null;
  if (!targetRepos.every((r): r is string => typeof r === 'string' && r.length > 0)) return null;

  // Case-sensitive subset check — `Frontend` ≠ `frontend`.
  const availableSet = new Set(availableRepos);
  for (const r of targetRepos) {
    if (!availableSet.has(r)) return null;
  }

  // De-dupe while preserving order.
  const seen = new Set<string>();
  const dedupedTargets: string[] = [];
  for (const r of targetRepos) {
    if (!seen.has(r)) {
      seen.add(r);
      dedupedTargets.push(r);
    }
  }

  // If the LLM listed every repo, there's no scoping happening —
  // treat as null so downstream code skips the "scope decided" path
  // entirely (no skipped repos, no audit noise).
  if (dedupedTargets.length === availableRepos.length) return null;

  if (typeof rationale !== 'string') return null;
  const trimmedRationale = rationale.trim();
  if (trimmedRationale.length === 0) return null;
  if (trimmedRationale.length > MAX_RATIONALE_LEN) return null;

  return {
    targetRepos: dedupedTargets,
    rationale: trimmedRationale,
  };
}
