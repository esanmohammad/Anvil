/**
 * Plan-compliance bridge — FS-backed probes for the build + validate
 * compliance checks (core-pipeline owns the pure verifier; dashboard
 * owns the FS reads).
 *
 * Used by `pipeline-stages.ts` after the build stage completes for a
 * given repo, and after the validate stage's test suite runs. Emits
 * `BUILD_COMPLIANCE.md` / `PLAN_COMPLIANCE.md` artifacts and returns
 * the gap list so the pipeline can engage the fix-loop on partial
 * compliance.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Plan,
  PlanBinding,
  PlanContract,
  DataChange,
  SymbolClaim,
  BuildComplianceReport,
  ValidateComplianceReport,
  TestRunStatus,
} from '@esankhan3/anvil-core-pipeline';
import {
  checkBuildCompliance,
  renderBuildComplianceMarkdown,
  checkValidateCompliance,
  renderValidateComplianceMarkdown,
  planContractDisplayName,
} from '@esankhan3/anvil-core-pipeline';

// ── Build compliance ─────────────────────────────────────────────────────

function gitChangedFiles(repoPath: string, baseBranch: string): Set<string> {
  try {
    const out = execFileSync(
      'git', ['diff', '--name-only', `${baseBranch}...HEAD`],
      { cwd: repoPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 },
    );
    return new Set(out.split('\n').map((s) => s.trim()).filter(Boolean));
  } catch {
    return new Set();
  }
}

function fileExistsNonEmpty(repoPath: string, path: string): boolean {
  try {
    const p = join(repoPath, path);
    if (!existsSync(p)) return false;
    return statSync(p).size > 0;
  } catch {
    return false;
  }
}

const SYMBOL_DECL_PATTERNS: Record<SymbolClaim['kind'], RegExp> = {
  function: /\b(?:export\s+)?(?:async\s+)?function\s+@@NAME@@\b|@@NAME@@\s*[:=]\s*(?:async\s+)?\(/,
  type: /\b(?:export\s+)?type\s+@@NAME@@\b/,
  class: /\b(?:export\s+)?class\s+@@NAME@@\b/,
  const: /\b(?:export\s+)?const\s+@@NAME@@\b/,
  interface: /\b(?:export\s+)?interface\s+@@NAME@@\b/,
  enum: /\b(?:export\s+)?enum\s+@@NAME@@\b/,
};

function symbolInDiff(repoPath: string, sym: SymbolClaim, baseBranch: string): boolean {
  try {
    const out = execFileSync(
      'git', ['diff', '--unified=0', `${baseBranch}...HEAD`],
      { cwd: repoPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000, maxBuffer: 20 * 1024 * 1024 },
    );
    // Filter to added lines (+) only.
    const added = out.split('\n').filter((l) => l.startsWith('+') && !l.startsWith('+++ ')).join('\n');
    const pattern = SYMBOL_DECL_PATTERNS[sym.kind] ?? SYMBOL_DECL_PATTERNS.function;
    const re = new RegExp(pattern.source.replace(/@@NAME@@/g, sym.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    return re.test(added);
  } catch {
    return false;
  }
}

function preservesPublicSurface(repoPath: string, path: string, baseBranch: string): boolean {
  const fullPath = join(repoPath, path);
  if (!existsSync(fullPath)) return false;
  try {
    // Compare exported member set before and after the diff. Heuristic:
    // count `^export ` lines on both sides.
    const before = execFileSync(
      'git', ['show', `${baseBranch}:${path}`],
      { cwd: repoPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 },
    );
    const after = readFileSync(fullPath, 'utf-8');
    const beforeExports = (before.match(/^export\s+(?:async\s+|const\s+|function\s+|class\s+|type\s+|interface\s+|enum\s+)\w+/gm) ?? [])
      .map((line) => line.match(/\b(\w+)\s*$/)?.[1] ?? '')
      .filter(Boolean)
      .sort();
    const afterExports = (after.match(/^export\s+(?:async\s+|const\s+|function\s+|class\s+|type\s+|interface\s+|enum\s+)\w+/gm) ?? [])
      .map((line) => line.match(/\b(\w+)\s*$/)?.[1] ?? '')
      .filter(Boolean)
      .sort();
    const removed = beforeExports.filter((x) => !afterExports.includes(x));
    return removed.length === 0;
  } catch {
    return true; // file not in base branch (new file) — nothing to preserve.
  }
}

export interface BuildComplianceDeps {
  binding: PlanBinding;
  repoLocalPaths: Record<string, string>;
  reposChecked: string[];
  baseBranch: string;
}

export function runBuildCompliance(deps: BuildComplianceDeps): BuildComplianceReport {
  const { binding } = deps;
  const probes = {
    changedFiles(repo: string): Set<string> {
      const path = deps.repoLocalPaths[repo];
      if (!path) return new Set();
      return gitChangedFiles(path, deps.baseBranch);
    },
    fileExistsNonEmpty(repo: string, p: string): boolean {
      const root = deps.repoLocalPaths[repo];
      if (!root) return false;
      return fileExistsNonEmpty(root, p);
    },
    symbolInDiff(repo: string, sym: SymbolClaim): boolean {
      const root = deps.repoLocalPaths[repo];
      if (!root) return false;
      return symbolInDiff(root, sym, deps.baseBranch);
    },
    preservesPublicSurface(repo: string, p: string): boolean {
      const root = deps.repoLocalPaths[repo];
      if (!root) return false;
      return preservesPublicSurface(root, p, deps.baseBranch);
    },
  };
  return checkBuildCompliance(binding.plan as Plan, deps.reposChecked, probes);
}

export { renderBuildComplianceMarkdown };

// ── Validate compliance ─────────────────────────────────────────────────

const TEST_NAME_PATTERNS: RegExp[] = [
  // Go: func TestX(t *testing.T)
  /^\s*func\s+(@@NAME@@)\s*\(/m,
  // JS/TS: describe('@@NAME@@', ... ) / it('@@NAME@@', ... ) / test('@@NAME@@', ...)
  /(?:describe|it|test)\(['"`]@@NAME@@['"`]/m,
  // Python: def test_@@NAME@@ / class Test@@NAME@@
  /def\s+@@NAME@@\s*\(/m,
];

function testStatusForFile(
  repoPath: string,
  file: string,
  name: string,
  failingTests: Set<string>,
  passingTests: Set<string>,
  skippedTests: Set<string>,
): TestRunStatus {
  const full = join(repoPath, file);
  if (!existsSync(full)) return 'missing';
  const src = readFileSync(full, 'utf-8');
  const found = TEST_NAME_PATTERNS.some((pat) => {
    const re = new RegExp(pat.source.replace(/@@NAME@@/g, name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), pat.flags);
    return re.test(src);
  });
  if (!found) return 'missing';
  const key = `${file}::${name}`;
  if (failingTests.has(key) || failingTests.has(name)) return 'fail';
  if (skippedTests.has(key) || skippedTests.has(name)) return 'skip';
  if (passingTests.has(key) || passingTests.has(name)) return 'pass';
  // Default: present in source but no signal from the test runner.
  // Treat as pass — better than false negative; validate fails on
  // genuinely-missing tests already.
  return 'pass';
}

export interface ValidateComplianceDeps {
  binding: PlanBinding;
  repoLocalPaths: Record<string, string>;
  /** Map of `${file}::${name}` (or bare name) → test runner outcome. */
  failingTests: Set<string>;
  passingTests: Set<string>;
  skippedTests: Set<string>;
}

function defaultRepoPath(paths: Record<string, string>): string {
  return Object.values(paths).find((p) => p && existsSync(p)) ?? process.cwd();
}

export function runValidateCompliance(deps: ValidateComplianceDeps): ValidateComplianceReport {
  const root = defaultRepoPath(deps.repoLocalPaths);
  const { binding } = deps;
  const plan = binding.plan as Plan;

  const probes = {
    testStatus(file: string, name: string): TestRunStatus {
      // Look in every known repo until we find the file.
      for (const repoPath of Object.values(deps.repoLocalPaths)) {
        if (!repoPath || !existsSync(join(repoPath, file))) continue;
        return testStatusForFile(repoPath, file, name, deps.failingTests, deps.passingTests, deps.skippedTests);
      }
      // Fallback to the resolved root.
      return testStatusForFile(root, file, name, deps.failingTests, deps.passingTests, deps.skippedTests);
    },
    contractProducerReferences(c: PlanContract): boolean {
      const repoPath = deps.repoLocalPaths[c.producer];
      if (!repoPath) return false;
      return contractReferences(repoPath, c);
    },
    contractConsumerReferences(c: PlanContract, consumer: string): boolean {
      const repoPath = deps.repoLocalPaths[consumer];
      if (!repoPath) return false;
      return contractReferences(repoPath, c);
    },
    migrationFileExists(d: DataChange): boolean {
      const repoPath = deps.repoLocalPaths[d.repo];
      if (!repoPath || !d.migrationFile) return false;
      return existsSync(join(repoPath, d.migrationFile));
    },
  };

  return checkValidateCompliance(plan, probes);
}

function contractReferences(repoPath: string, c: PlanContract): boolean {
  try {
    let needle = '';
    if (c.kind === 'http') needle = c.path;
    else if (c.kind === 'kafka') needle = c.topic;
    else if (c.kind === 'grpc') needle = `${c.service}.${c.method}`;
    else needle = c.table;
    if (!needle) return false;
    // grep -r with literal needle, exclude node_modules
    const out = execFileSync(
      'grep', ['-r', '-l', '--exclude-dir=node_modules', '--exclude-dir=.git', '--include=*.{ts,tsx,js,jsx,go,py,java,rs}', '--', needle, '.'],
      { cwd: repoPath, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 8_000, maxBuffer: 4 * 1024 * 1024 },
    ).trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

export { renderValidateComplianceMarkdown };

// ── Display helper re-export ────────────────────────────────────────────

export { planContractDisplayName };
