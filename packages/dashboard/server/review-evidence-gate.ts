/**
 * review-evidence-gate — R2 orchestrator. Runs each pure-code evidence check
 * on every finding and drops the ones that fail any check (skipped checks
 * never cause a drop). Accumulates per-check results on the finding.
 */

import type {
  EnrichedFinding,
  EvidenceCheckResult,
} from './review-finding-extensions.js';
import {
  appendEvidenceCheck,
} from './review-finding-extensions.js';
import { checkQuoteInDiff } from './review-checks/quote-check.js';
import { checkSymbolExists } from './review-checks/symbol-check.js';
import { checkTypeClaim } from './review-checks/type-check.js';
import { checkPrecedent } from './review-checks/precedent-check.js';
import { checkCallerContract } from './review-checks/caller-contract-check.js';
import { checkTestExists } from './review-checks/test-exists-check.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface EvidenceGateDeps {
  repoLocalPath: string;
  diffText: string;
  fileContents: Record<string, string>;
  astGraph?: unknown;
  /** Override for precedent-check minPrecedents. */
  minPrecedents?: number;
  /** When false, suppress console.warn logging of dropped reasons. */
  quiet?: boolean;
}

export interface DroppedEntry {
  finding: EnrichedFinding;
  reasons: string[];
}

export interface EvidenceGateResult {
  kept: EnrichedFinding[];
  dropped: DroppedEntry[];
}

type CheckName =
  | 'quote'
  | 'symbol'
  | 'type'
  | 'precedent'
  | 'caller-contract'
  | 'test-exists';

interface NormalizedCheck {
  name: CheckName;
  result: EvidenceCheckResult;
  skipped: boolean;
}

// ── Helpers ──────────────────────────────────────────────────────────────

function isSkipped(result: EvidenceCheckResult): boolean {
  const detail = (result.detail ?? '').toLowerCase();
  return result.passed && detail.startsWith('skipped');
}

function toCheck(
  name: CheckName,
  res: { passed: boolean; detail?: string },
): NormalizedCheck {
  const result: EvidenceCheckResult = { name, passed: res.passed, detail: res.detail };
  return { name, result, skipped: isSkipped(result) };
}

function logDropped(
  quiet: boolean | undefined,
  finding: EnrichedFinding,
  reasons: string[],
): void {
  if (quiet) return;
  const loc = `${finding.file}:${finding.line}`;
  const reasonList = reasons.join('; ');
  // eslint-disable-next-line no-console
  console.warn(
    `[evidence-gate] dropped finding ${finding.id} at ${loc}: ${reasonList}`,
  );
}

// ── Public API ───────────────────────────────────────────────────────────

/**
 * Runs the six evidence checks on each finding. A finding is dropped when
 * any check explicitly fails (skipped checks never cause a drop). Each
 * check result is recorded on `finding.evidenceChecks[]`.
 */
export async function applyEvidenceGate(
  findings: EnrichedFinding[],
  deps: EvidenceGateDeps,
): Promise<EvidenceGateResult> {
  const kept: EnrichedFinding[] = [];
  const dropped: DroppedEntry[] = [];

  for (const original of findings) {
    let finding: EnrichedFinding = { ...original };
    const checks: NormalizedCheck[] = [];

    // 1. Quote check — purely textual, cheap.
    checks.push(
      toCheck('quote', checkQuoteInDiff(finding, deps.diffText)),
    );

    // 2. Symbol check — needs file content.
    const fileContent = deps.fileContents[finding.file] ?? '';
    checks.push(
      toCheck('symbol', checkSymbolExists(finding, deps.repoLocalPath, fileContent)),
    );

    // 3. Type check — may shell out to tsc/pyright/go vet.
    try {
      const typeRes = await checkTypeClaim(
        finding,
        deps.repoLocalPath,
        finding.file,
      );
      checks.push(toCheck('type', typeRes));
    } catch (err) {
      checks.push({
        name: 'type',
        result: {
          name: 'type',
          passed: true,
          detail: `skipped: type-check threw: ${errorMessage(err)}`,
        },
        skipped: true,
      });
    }

    // 4. Precedent check.
    checks.push(
      toCheck(
        'precedent',
        checkPrecedent(finding, deps.repoLocalPath, {
          minPrecedents: deps.minPrecedents,
        }),
      ),
    );

    // 5. Caller contract check.
    checks.push(
      toCheck(
        'caller-contract',
        checkCallerContract(finding, deps.repoLocalPath, deps.astGraph),
      ),
    );

    // 6. Test exists check.
    checks.push(
      toCheck('test-exists', checkTestExists(finding, deps.repoLocalPath)),
    );

    // Accumulate results on the finding.
    for (const c of checks) {
      finding = appendEvidenceCheck(finding, c.result);
    }

    // A finding is dropped if any non-skipped check failed.
    const failed = checks.filter((c) => !c.skipped && !c.result.passed);
    if (failed.length > 0) {
      const reasons = failed.map(
        (c) => `${c.name}: ${c.result.detail ?? 'failed'}`,
      );
      const demotedFinding: EnrichedFinding = { ...finding, demoted: true };
      dropped.push({ finding: demotedFinding, reasons });
      logDropped(deps.quiet, demotedFinding, reasons);
      continue;
    }

    kept.push(finding);
  }

  return { kept, dropped };
}

// ── Internal ─────────────────────────────────────────────────────────────

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
