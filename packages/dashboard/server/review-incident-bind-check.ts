/**
 * review-incident-bind-check — Review Phase R7 regression-guard gate.
 *
 * When a PR touches a file that is registered as a regression-test guard in
 * the project's BoundTestsStore, this module emits a pre-authored, immutable
 * blocker finding. These findings are built to bypass every downstream review
 * filter (scope, evidence, convention, dismissal, calibration) because the
 * whole point is that a bound-test regression guard cannot be silently
 * dropped — deletion or modification always requires a human override.
 *
 * Two classes of event are recognised:
 *   - Deletion   (removed > 0 and added === 0) — strongest blocker message.
 *   - Modification (anything else that touches a bound file) — blocker asking
 *                  the reviewer to verify the incident still reproduces.
 *
 * Every finding carries an `evidenceChecks` array with one pre-passed entry
 * (`bound-registry`) so the review pipeline's evidence gate always lets it
 * through. Severity is hard-wired to `blocker` and `immutable` to `true`.
 *
 * Pure module — no I/O beyond what the injected BoundTestsStore performs.
 */

import { randomBytes } from 'node:crypto';
import type { BoundTest, BoundTestsStore } from './bound-tests.js';

// ── Public types ─────────────────────────────────────────────────────────

export interface ChangedFile {
  path: string;
  added: number;
  removed: number;
}

export interface EvidenceCheck {
  name: string;
  passed: true;
  detail: string;
}

export interface IncidentBindFinding {
  id: string;
  severity: 'blocker';
  immutable: true;
  claimType: 'security';
  category: 'regression-guard';
  filePath: string;
  message: string;
  incidentId: string;
  replayId: string;
  addedAt: string;
  evidenceChecks: EvidenceCheck[];
}

export interface IncidentBindCheckDeps {
  boundStore: BoundTestsStore;
}

// ── Internal helpers ─────────────────────────────────────────────────────

function makeId(): string {
  return `bind-${randomBytes(8).toString('hex')}`;
}

function isDeletion(change: ChangedFile): boolean {
  return change.removed > 0 && change.added === 0;
}

function buildMessage(match: BoundTest, change: ChangedFile): string {
  if (isDeletion(change)) {
    return (
      `Deletion of a regression guard — override required. ` +
      `This file guards incident ${match.incidentId} (replay ${match.replayId}); ` +
      `removing it strips the regression test that proves the bug stays fixed.`
    );
  }
  return (
    `Modification of a file guarding incident ${match.incidentId} — ` +
    `verify the regression test still reproduces. Replay ${match.replayId} ` +
    `was bound to this file on ${match.addedAt}; any change must preserve ` +
    `the original failure path or be justified via a written override reason.`
  );
}

function buildEvidenceChecks(match: BoundTest): EvidenceCheck[] {
  return [
    {
      name: 'bound-registry',
      passed: true,
      detail: 'found in bound-tests.json',
    },
    {
      name: 'incident-link',
      passed: true,
      detail: `linked to incident ${match.incidentId} via replay ${match.replayId}`,
    },
  ];
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * For each changed file in the PR, look up the project's bound-test registry
 * and emit a blocker finding if the file is a registered regression guard.
 *
 * Output is stable-sorted by filePath so reviewers see a deterministic list
 * and downstream code can deduplicate safely.
 */
export function checkIncidentBindings(
  project: string,
  changedFiles: ChangedFile[],
  deps: IncidentBindCheckDeps,
): IncidentBindFinding[] {
  if (!Array.isArray(changedFiles) || changedFiles.length === 0) return [];

  const bound = deps.boundStore.listBound(project);
  if (bound.length === 0) return [];

  const byPath = new Map<string, BoundTest>();
  for (const b of bound) byPath.set(b.filePath, b);

  const findings: IncidentBindFinding[] = [];
  const seen = new Set<string>();

  for (const change of changedFiles) {
    if (!change || typeof change.path !== 'string') continue;
    if (seen.has(change.path)) continue;

    const match = byPath.get(change.path);
    if (!match) continue;
    seen.add(change.path);

    findings.push({
      id: makeId(),
      severity: 'blocker',
      immutable: true,
      claimType: 'security',
      category: 'regression-guard',
      filePath: match.filePath,
      message: buildMessage(match, change),
      incidentId: match.incidentId,
      replayId: match.replayId,
      addedAt: match.addedAt,
      evidenceChecks: buildEvidenceChecks(match),
    });
  }

  findings.sort((a, b) => a.filePath.localeCompare(b.filePath));
  return findings;
}
