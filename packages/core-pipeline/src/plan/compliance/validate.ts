/**
 * Validate-stage plan-compliance check.
 *
 * Phase F — runs after the validate stage's test suite. For each
 * TestCaseSpec in `plan.tests.unit + .integration`, confirms a test
 * with that exact name exists in the named file and passes (not
 * skipped). For each contract, confirms the producer + consumer
 * code paths reference it. For each data change, confirms the
 * migration file exists.
 *
 * Pure function with caller-supplied probes (mirrors build.ts).
 */

import type {
  Plan,
  TestCaseSpec,
  PlanContract,
  DataChange,
} from '../../utils/plan-types.js';
import { planContractDisplayName } from '../../utils/plan-types.js';

export type ValidateGapKind =
  | 'test-missing'
  | 'test-skipped'
  | 'test-failing'
  | 'contract-producer-missing'
  | 'contract-consumer-missing'
  | 'migration-file-missing';

export interface ValidateComplianceGap {
  kind: ValidateGapKind;
  path: string;
  detail: string;
  severity: 'low' | 'med' | 'high';
}

export interface ValidateComplianceReport {
  planSlug: string;
  planVersion: number;
  planHash: string;
  gaps: ValidateComplianceGap[];
  passed: number;
  total: number;
  fullCompliance: boolean;
}

export type TestRunStatus = 'pass' | 'fail' | 'skip' | 'missing';

export interface ValidateComplianceProbes {
  /**
   * Status of a named test in a file. `missing` if no test with that
   * exact name was found.
   */
  testStatus(file: string, name: string): TestRunStatus;
  /** Whether the producer repo references the contract (route/topic/etc). */
  contractProducerReferences(c: PlanContract): boolean;
  /** Whether each consumer references the contract. */
  contractConsumerReferences(c: PlanContract, consumer: string): boolean;
  /** Whether a migration file exists. */
  migrationFileExists(d: DataChange): boolean;
}

function gap(
  kind: ValidateGapKind,
  path: string,
  detail: string,
  severity: ValidateComplianceGap['severity'] = 'high',
): ValidateComplianceGap {
  return { kind, path, detail, severity };
}

function checkTests(plan: Plan, probes: ValidateComplianceProbes): {
  gaps: ValidateComplianceGap[]; passed: number; total: number;
} {
  const gaps: ValidateComplianceGap[] = [];
  let passed = 0;
  let total = 0;
  const buckets: Array<['unit' | 'integration', TestCaseSpec[]]> = [
    ['unit', plan.tests.unit],
    ['integration', plan.tests.integration],
  ];
  for (const [bucket, specs] of buckets) {
    for (let i = 0; i < specs.length; i++) {
      const spec = specs[i];
      total++;
      if (!spec.file || !spec.name) {
        gaps.push(gap(
          'test-missing',
          `tests.${bucket}[${i}]`,
          `TestCaseSpec "${spec.id || `#${i}`}" missing file or name`,
        ));
        continue;
      }
      const status = probes.testStatus(spec.file, spec.name);
      if (status === 'missing') {
        gaps.push(gap(
          'test-missing',
          `tests.${bucket}[${i}]`,
          `${spec.name} not found in ${spec.file}`,
        ));
      } else if (status === 'skip') {
        gaps.push(gap(
          'test-skipped',
          `tests.${bucket}[${i}]`,
          `${spec.name} in ${spec.file} is skipped — implement before merge`,
          'med',
        ));
      } else if (status === 'fail') {
        gaps.push(gap(
          'test-failing',
          `tests.${bucket}[${i}]`,
          `${spec.name} in ${spec.file} failed`,
        ));
      } else {
        passed++;
      }
    }
  }
  return { gaps, passed, total };
}

function checkContracts(plan: Plan, probes: ValidateComplianceProbes): {
  gaps: ValidateComplianceGap[]; passed: number; total: number;
} {
  const gaps: ValidateComplianceGap[] = [];
  let passed = 0;
  let total = 0;
  for (let i = 0; i < plan.contracts.length; i++) {
    const c = plan.contracts[i];
    const display = planContractDisplayName(c);
    total++;
    if (!probes.contractProducerReferences(c)) {
      gaps.push(gap(
        'contract-producer-missing',
        `contracts[${i}].producer`,
        `producer "${c.producer}" does not reference ${c.kind} contract "${display}"`,
      ));
    } else {
      passed++;
    }
    // Consumer checks — db contracts have no consumers.
    if (c.kind === 'db') continue;
    for (let j = 0; j < c.consumers.length; j++) {
      const consumer = c.consumers[j];
      total++;
      if (!probes.contractConsumerReferences(c, consumer)) {
        gaps.push(gap(
          'contract-consumer-missing',
          `contracts[${i}].consumers[${j}]`,
          `consumer "${consumer}" does not reference ${c.kind} contract "${display}"`,
          'med',
        ));
      } else {
        passed++;
      }
    }
  }
  return { gaps, passed, total };
}

function checkData(plan: Plan, probes: ValidateComplianceProbes): {
  gaps: ValidateComplianceGap[]; passed: number; total: number;
} {
  const gaps: ValidateComplianceGap[] = [];
  let passed = 0;
  let total = 0;
  for (let i = 0; i < plan.data.length; i++) {
    const d = plan.data[i];
    if (!d.migrationFile) continue;
    total++;
    if (!probes.migrationFileExists(d)) {
      gaps.push(gap(
        'migration-file-missing',
        `data[${i}].migrationFile`,
        `migration file "${d.migrationFile}" missing in repo "${d.repo}"`,
      ));
    } else {
      passed++;
    }
  }
  return { gaps, passed, total };
}

export function checkValidateCompliance(
  plan: Plan,
  probes: ValidateComplianceProbes,
): ValidateComplianceReport {
  const t = checkTests(plan, probes);
  const c = checkContracts(plan, probes);
  const d = checkData(plan, probes);
  const allGaps = [...t.gaps, ...c.gaps, ...d.gaps];
  return {
    planSlug: plan.slug,
    planVersion: plan.version,
    planHash: plan.contentHash,
    gaps: allGaps,
    passed: t.passed + c.passed + d.passed,
    total: t.total + c.total + d.total,
    fullCompliance: allGaps.length === 0,
  };
}

export function renderValidateComplianceMarkdown(report: ValidateComplianceReport): string {
  const lines: string[] = [];
  lines.push('# Plan compliance');
  lines.push(`Plan: \`${report.planSlug}\` v${report.planVersion} (hash: \`${report.planHash.slice(0, 12)}\`)`);
  lines.push(`Passed: ${report.passed}/${report.total}${report.fullCompliance ? '  ✅' : '  ❌'}`);
  lines.push('');
  if (report.gaps.length === 0) {
    lines.push('All plan tests + contracts + data claims verified.');
    return lines.join('\n');
  }
  lines.push('## Gaps');
  for (const g of report.gaps) {
    lines.push(`- **[${g.severity.toUpperCase()}] ${g.kind}** — \`${g.path}\` · ${g.detail}`);
  }
  return lines.join('\n');
}
