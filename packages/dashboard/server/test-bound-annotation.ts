/**
 * test-bound-annotation — pure function that produces GitHub-Checks-style
 * annotations flagging PR changes that touch an incident-bound test file.
 *
 * Bound regression tests are the outputs of successful bug-to-test replays.
 * They must not be modified or deleted without an explicit override (see
 * `bound-tests.ts`). When a PR diff touches one of these files, Anvil's
 * checks publisher surfaces a warning inline on the first changed line so
 * the author sees the constraint before review starts.
 *
 * This module is pure and synchronous — no file I/O, no network. The
 * `annotation_level` is implicit `warning`; the caller (typically the
 * test-checks-publisher) maps it onto whatever check-run shape the API
 * expects.
 */

// ── Public types ─────────────────────────────────────────────────────────

export interface BoundTouchAnnotation {
  file: string;
  line: number;
  message: string;
  title: string;
}

export interface PrDiffFile {
  path: string;
  changedLines: number[];
}

export interface BoundTestRef {
  filePath: string;
  incidentId: string;
}

// ── Implementation ───────────────────────────────────────────────────────

/**
 * For each PR diff file whose path matches a boundTest filePath, emit a
 * single annotation on the first changed line. If a bound test appears
 * multiple times in the diff-file list (shouldn't, but be tolerant), only
 * the first match produces an annotation. Files with no changed lines are
 * skipped.
 *
 * The annotation's `annotation_level` is implicit `warning` — the caller
 * maps to the concrete shape its API uses (`warning` for GitHub Checks,
 * `WARNING` for GitLab, etc).
 */
export function buildBoundTouchAnnotations(
  prDiffFiles: Array<{ path: string; changedLines: number[] }>,
  boundTests: Array<{ filePath: string; incidentId: string }>,
): BoundTouchAnnotation[] {
  if (prDiffFiles.length === 0 || boundTests.length === 0) return [];

  // Build a lookup keyed by the normalised bound-test path so we can match
  // in a single pass regardless of diff-file ordering.
  const boundByPath = new Map<string, string>(); // path -> incidentId
  for (const b of boundTests) {
    if (!b || typeof b.filePath !== 'string' || typeof b.incidentId !== 'string') continue;
    const key = normalisePath(b.filePath);
    if (key.length === 0) continue;
    // Keep the first-registered incidentId on duplicates — list order wins.
    if (!boundByPath.has(key)) boundByPath.set(key, b.incidentId);
  }

  if (boundByPath.size === 0) return [];

  const out: BoundTouchAnnotation[] = [];
  const emitted = new Set<string>();

  for (const file of prDiffFiles) {
    if (!file || typeof file.path !== 'string') continue;
    const key = normalisePath(file.path);
    if (emitted.has(key)) continue;

    const incidentId = boundByPath.get(key);
    if (!incidentId) continue;

    const firstLine = firstChangedLine(file.changedLines);
    if (firstLine === null) continue;

    out.push({
      file: file.path,
      line: firstLine,
      title: 'Anvil: touching incident-bound test',
      message:
        `This test file is bound to incident ${incidentId}. ` +
        `Modifying it requires an override. Add a sibling test instead, ` +
        `or run \`anvil incidents override-bind\`.`,
    });
    emitted.add(key);
  }

  return out;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function firstChangedLine(lines: number[] | undefined): number | null {
  if (!Array.isArray(lines) || lines.length === 0) return null;
  let best: number | null = null;
  for (const n of lines) {
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) continue;
    const int = Math.trunc(n);
    if (best === null || int < best) best = int;
  }
  return best;
}

function normalisePath(p: string): string {
  // Strip a leading `./` and collapse backslashes so Windows-style paths
  // compare equal to the POSIX form used in bound-tests.json.
  let out = p.trim().replace(/\\+/g, '/');
  while (out.startsWith('./')) out = out.slice(2);
  return out;
}
