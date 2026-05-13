/**
 * review-plan-compliance — wraps plan-deviation into a compliance report
 * and derives `plan-drift` findings that the Review surface consumes.
 */

import { captureDeviation } from './plan-deviation.js';
import { newFindingId } from './review-store.js';
import type { Plan } from './plan-store.js';
import type { PlanComplianceReport, ReviewFinding } from './review-store.js';

export interface ComplianceInput {
  plan: Plan;
  /** PR feature dir (where plan-deviation.json will live). */
  featureDir: string;
  /** repo name → local filesystem path. */
  repoLocalPaths: Record<string, string>;
  baseBranch: string;
  branch: string;
}

export interface ComplianceOutput {
  report: PlanComplianceReport;
  findings: ReviewFinding[];
}

/** Parse "produces/consumes" contract name from a plan contract entry. */
function contractKey(name: string, kind: string): string {
  return `${kind.toUpperCase()}:${name}`;
}

/**
 * Heuristic: did the diff deliver this contract? We look for the contract name
 * as a substring in the added files' paths or symbol names. Much cheaper than
 * a proper parse and catches the common case (naming convention follows the
 * contract name).
 */
function diffMentionsContract(contractName: string, addedFiles: string[]): boolean {
  const needle = contractName.toLowerCase().replace(/[^a-z0-9]/g, '');
  for (const f of addedFiles) {
    const norm = f.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (norm.includes(needle)) return true;
  }
  return false;
}

export function buildPlanCompliance(input: ComplianceInput): ComplianceOutput {
  const deviation = captureDeviation(input.plan, {
    featureDir: input.featureDir,
    repoLocalPaths: input.repoLocalPaths,
    baseBranch: input.baseBranch,
    branch: input.branch,
  });

  const allAddedFiles = deviation.repos.flatMap((r) => r.addedFiles);

  // Contract coverage — Plan v2: contract display name varies by kind.
  const deliveredContracts: string[] = [];
  const missingContracts: string[] = [];
  for (const c of input.plan.contracts) {
    const display = c.kind === 'http'
      ? `${c.method} ${c.path}`
      : c.kind === 'kafka' ? c.topic
      : c.kind === 'grpc' ? `${c.service}.${c.method}`
      : c.table;
    const key = contractKey(display, c.kind);
    if (diffMentionsContract(display, allAddedFiles)) deliveredContracts.push(key);
    else missingContracts.push(key);
  }

  // Symbol coverage — Plan v2: symbols are SymbolClaim objects.
  const missedSymbols: string[] = [];
  for (const r of input.plan.repos) {
    for (const sym of r.symbols) {
      const name = sym.name;
      const tail = name.split(/[./:]/).pop()?.toLowerCase() ?? name.toLowerCase();
      const repoDev = deviation.repos.find((d) => d.repo === r.name);
      const files = [...(repoDev?.matchedFiles ?? []), ...(repoDev?.addedFiles ?? [])];
      const hit = files.some((f) => f.toLowerCase().includes(tail));
      if (!hit) missedSymbols.push(`${r.name}::${name}`);
    }
  }

  const report: PlanComplianceReport = {
    matchRate: deviation.summary.matchRate,
    unplannedFiles: deviation.repos.flatMap((r) =>
      r.addedFiles.map((f) => ({
        repo: r.repo,
        file: f,
        severity: 'info' as const,
      })),
    ),
    missedFiles: deviation.repos.flatMap((r) =>
      r.skippedFiles.map((f) => ({
        repo: r.repo,
        file: f,
        severity: 'warn' as const,
      })),
    ),
    missedSymbols,
    deliveredContracts,
    missingContracts,
  };

  const now = new Date().toISOString();
  const findings: ReviewFinding[] = [];

  // Missed files → warn
  for (const m of report.missedFiles) {
    findings.push({
      id: newFindingId(),
      severity: 'warn',
      category: 'plan-drift',
      persona: 'architect',
      file: m.file,
      line: 0,
      snippet: '',
      description: `Plan claimed "${m.file}" would change in ${m.repo}, but the diff doesn't touch it. Either update the plan or add the change.`,
      suggestedFix: null,
      confidence: 'high',
      resolution: 'pending',
      createdAt: now,
    });
  }

  // Missing contracts → error (more severe — contract is the surface users rely on)
  for (const c of report.missingContracts) {
    findings.push({
      id: newFindingId(),
      severity: 'error',
      category: 'plan-drift',
      persona: 'architect',
      file: '',
      line: 0,
      snippet: '',
      description: `Plan defined cross-repo contract ${c}, but the diff doesn't appear to expose or wire it. Verify downstream consumers won't break.`,
      suggestedFix: null,
      confidence: 'med',
      resolution: 'pending',
      createdAt: now,
    });
  }

  // Missed symbols → warn (symbol rename is common; be medium-confidence)
  if (missedSymbols.length) {
    findings.push({
      id: newFindingId(),
      severity: 'warn',
      category: 'plan-drift',
      persona: 'architect',
      file: '',
      line: 0,
      snippet: '',
      description: `Plan named ${missedSymbols.length} symbol(s) not found in the diff: ${missedSymbols.slice(0, 5).join(', ')}${missedSymbols.length > 5 ? '…' : ''}. Renamed, skipped, or still-to-do?`,
      suggestedFix: null,
      confidence: 'med',
      resolution: 'pending',
      createdAt: now,
    });
  }

  // Significant unplanned scope → info (not necessarily wrong, but worth noting)
  const unplannedCount = report.unplannedFiles.length;
  if (unplannedCount > 3) {
    findings.push({
      id: newFindingId(),
      severity: 'info',
      category: 'plan-drift',
      persona: 'architect',
      file: '',
      line: 0,
      snippet: '',
      description: `PR touches ${unplannedCount} files outside the plan. Consider updating the plan (helps future reviews) or splitting this PR.`,
      suggestedFix: null,
      confidence: 'med',
      resolution: 'pending',
      createdAt: now,
    });
  }

  return { report, findings };
}
