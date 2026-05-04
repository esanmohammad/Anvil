/**
 * bound-tests-annotator — builds PR inline annotations when a pull request
 * touches a bound-regression test file. Pure module; no I/O.
 */

import type { BoundTest, BoundTestsStore } from './bound-tests.js';

// ── Public types ─────────────────────────────────────────────────────────

export interface PRDiffHunk {
  filePath: string;
  addedLines: number;
  removedLines: number;
}

export type AnnotationSeverity = 'info' | 'warning' | 'block';

export interface BoundAnnotation {
  filePath: string;
  incidentId: string;
  replayId: string;
  message: string;
  severity: AnnotationSeverity;
}

export interface BuildAnnotationsOptions {
  /**
   * Heuristic threshold (0..1): if the ratio of changed lines (added+removed)
   * to (added+removed) that appear to be whitespace-only is greater than or
   * equal to this value, the change is downgraded to 'info'. Since we only
   * have numeric hunks (no raw diff text), we approximate: when the net
   * change equals zero AND one of added/removed is ≤ the threshold of the
   * other, we treat it as a whitespace/rename-style diff.
   */
  whitespaceRatioThreshold?: number;
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Build annotations for the subset of `hunks` whose file paths match a
 * bound-test record for `project`. Output is deduplicated per filePath,
 * sorted by filePath ascending, and contains exactly one annotation per
 * touched bound file.
 */
export function buildBoundAnnotations(
  boundStore: BoundTestsStore,
  project: string,
  hunks: PRDiffHunk[],
  opts: BuildAnnotationsOptions = {},
): BoundAnnotation[] {
  if (!Array.isArray(hunks) || hunks.length === 0) return [];

  const bound = boundStore.listBound(project);
  if (bound.length === 0) return [];

  const boundByPath = new Map<string, BoundTest>();
  for (const b of bound) boundByPath.set(b.filePath, b);

  // Dedupe hunks per filePath (sum when multiple hunks reference same file).
  const mergedHunks = mergeHunks(hunks);

  const out: BoundAnnotation[] = [];
  for (const hunk of mergedHunks) {
    const match = boundByPath.get(hunk.filePath);
    if (!match) continue;

    const severity = classify(hunk, opts.whitespaceRatioThreshold ?? 0.1);
    out.push({
      filePath: match.filePath,
      incidentId: match.incidentId,
      replayId: match.replayId,
      severity,
      message: buildMessage(match, severity),
    });
  }

  // Stable ordering for predictable comment rendering / test assertions.
  out.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return out;
}

// ── Internals ────────────────────────────────────────────────────────────

function mergeHunks(hunks: PRDiffHunk[]): PRDiffHunk[] {
  const byPath = new Map<string, PRDiffHunk>();
  for (const h of hunks) {
    if (!h || typeof h.filePath !== 'string') continue;
    const added = Number.isFinite(h.addedLines) ? Math.max(0, h.addedLines) : 0;
    const removed = Number.isFinite(h.removedLines)
      ? Math.max(0, h.removedLines)
      : 0;
    const prev = byPath.get(h.filePath);
    if (prev) {
      prev.addedLines += added;
      prev.removedLines += removed;
    } else {
      byPath.set(h.filePath, {
        filePath: h.filePath,
        addedLines: added,
        removedLines: removed,
      });
    }
  }
  return Array.from(byPath.values());
}

function classify(
  hunk: PRDiffHunk,
  whitespaceRatioThreshold: number,
): AnnotationSeverity {
  const { addedLines, removedLines } = hunk;

  // Deletion: net removal with nothing added back.
  if (removedLines > 0 && addedLines === 0) return 'block';

  // No change at all — shouldn't happen, but treat as info.
  if (removedLines === 0 && addedLines === 0) return 'info';

  // Heuristic for "likely whitespace / rename-style" diff: equal add/remove
  // counts AND the smaller side is within `whitespaceRatioThreshold` of the
  // larger. We also cap size: more than 25 changed lines is probably real.
  const total = addedLines + removedLines;
  if (total <= 25 && addedLines === removedLines) {
    const smaller = Math.min(addedLines, removedLines);
    const larger = Math.max(addedLines, removedLines);
    if (larger === 0 || smaller / larger >= 1 - whitespaceRatioThreshold) {
      return 'info';
    }
  }

  return 'warning';
}

function buildMessage(match: BoundTest, severity: AnnotationSeverity): string {
  const base = `This file guards incident ${match.incidentId}.`;
  if (severity === 'block') {
    return `${base} Deletion requires override — see 'anvil incidents override'`;
  }
  if (severity === 'warning') {
    return `${base} Modifications require reviewer approval — see 'anvil incidents override' if intentional.`;
  }
  return `${base} Looks like a whitespace-only change; no action needed.`;
}
