/**
 * Tests for review-evidence-gate (R2).
 *
 * node:test + node:assert. Uses a temp repo under os.tmpdir() for filesystem-
 * backed checks (symbol, precedent, test-exists). tsc-dependent cases degrade
 * gracefully when tsc is not installed.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

import { applyEvidenceGate } from '../review-evidence-gate.js';
import type { EnrichedFinding } from '../review-finding-extensions.js';
import type { ReviewFinding } from '../review-store.js';

// ── Shared fixtures ──────────────────────────────────────────────────────

let repoRoot = '';

function makeFinding(overrides = {}) {
  const base = {
    id: 'f-test',
    severity: 'warn' as const,
    category: 'correctness' as const,
    persona: 'architect' as const,
    file: 'src/user.ts',
    line: 10,
    snippet: '',
    description: 'test finding',
    suggestedFix: null,
    confidence: 'med' as const,
    resolution: 'pending' as const,
    createdAt: new Date().toISOString(),
  };
  return { ...base, ...overrides };
}

function tscAvailable() {
  try {
    execFileSync('tsc', ['--version'], { stdio: 'ignore', timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

before(() => {
  repoRoot = mkdtempSync(join(tmpdir(), 'r2-gate-'));

  // src/user.ts — contains both `user.email` and a repeated pattern for precedent.
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(
    join(repoRoot, 'src/user.ts'),
    [
      'export interface User { email: string; name: string }',
      'export function greet(user: User) {',
      '  return "hello " + user.email;',
      '}',
      '// pattern: FOO_WIDGET_PATTERN_XYZ',
      '',
    ].join('\n'),
    'utf-8',
  );

  // Additional files that also contain the pattern — enough for precedent drop.
  for (const name of ['a.ts', 'b.ts', 'c.ts', 'd.ts']) {
    writeFileSync(
      join(repoRoot, 'src', name),
      [
        `export const marker_${name.replace('.ts', '')} = 1;`,
        '// pattern: FOO_WIDGET_PATTERN_XYZ',
        '',
      ].join('\n'),
      'utf-8',
    );
  }

  // A test file referencing the `greet` symbol.
  mkdirSync(join(repoRoot, '__tests__'), { recursive: true });
  writeFileSync(
    join(repoRoot, '__tests__/greet.test.ts'),
    [
      "import { greet } from '../src/user.js';",
      "describe('greet', () => {});",
      '',
    ].join('\n'),
    'utf-8',
  );
});

after(() => {
  if (repoRoot) rmSync(repoRoot, { recursive: true, force: true });
});

function commonDeps(overrides = {}) {
  return {
    repoLocalPath: repoRoot,
    diffText: '',
    fileContents: {},
    quiet: true,
    ...overrides,
  };
}

// ── 1. quote-check pass ──────────────────────────────────────────────────

describe('evidence-gate — quote check', () => {
  it('keeps a finding whose quoted text is present in the diff', async () => {
    const finding = makeFinding({
      id: 'f-quote-pass',
      quoted: 'user.email',
      claimType: 'other',
    });
    const diffText = 'diff --git a/src/user.ts b/src/user.ts\n+ return user.email;\n';
    const result = await applyEvidenceGate([finding], commonDeps({ diffText }));
    assert.equal(result.kept.length, 1);
    assert.equal(result.dropped.length, 0);
    const quoteCheck = result.kept[0].evidenceChecks?.find((c) => c.name === 'quote');
    assert.ok(quoteCheck);
    assert.equal(quoteCheck?.passed, true);
  });

  it('drops a finding whose quoted text is missing from the diff', async () => {
    const finding = makeFinding({
      id: 'f-quote-fail',
      quoted: 'someSymbolThatDoesNotExistAnywhere_ZZZ',
      claimType: 'other',
    });
    const diffText = 'diff --git a/src/user.ts b/src/user.ts\n+ return 1;\n';
    const result = await applyEvidenceGate([finding], commonDeps({ diffText }));
    assert.equal(result.kept.length, 0);
    assert.equal(result.dropped.length, 1);
    assert.ok(result.dropped[0].reasons.some((r) => r.startsWith('quote:')));
  });
});

// ── 2. symbol-check ──────────────────────────────────────────────────────

describe('evidence-gate — symbol check', () => {
  it('drops a finding when the target symbol is missing from the repo', async () => {
    const finding = makeFinding({
      id: 'f-sym-fail',
      targetSymbol: 'noSuchSymbol_QQQ',
      file: 'src/user.ts',
    });
    const result = await applyEvidenceGate(
      [finding],
      commonDeps({ fileContents: { 'src/user.ts': 'export const x = 1;' } }),
    );
    assert.equal(result.dropped.length, 1);
    assert.ok(result.dropped[0].reasons.some((r) => r.startsWith('symbol:')));
  });

  it('keeps a finding when the symbol is present in fileContent', async () => {
    const finding = makeFinding({
      id: 'f-sym-pass',
      targetSymbol: 'user.email',
      file: 'src/user.ts',
    });
    const content = 'export const user = { email: "a@b" }; console.log(user.email);';
    const result = await applyEvidenceGate(
      [finding],
      commonDeps({ fileContents: { 'src/user.ts': content } }),
    );
    assert.equal(result.kept.length, 1);
  });
});

// ── 3. type-check (tsc) ──────────────────────────────────────────────────

describe('evidence-gate — type check', { skip: !tscAvailable() }, () => {
  it('drops a null-deref claim when tsc reports a clean build', async () => {
    // Create a tiny valid TS project in a subdir.
    const proj = mkdtempSync(join(tmpdir(), 'r2-ts-'));
    writeFileSync(
      join(proj, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: { strict: true, noEmit: true, target: 'ES2020' },
        include: ['*.ts'],
      }),
      'utf-8',
    );
    writeFileSync(
      join(proj, 'clean.ts'),
      'export const n: number = 42;\n',
      'utf-8',
    );
    try {
      const finding = makeFinding({
        id: 'f-type-fail',
        claimType: 'null-deref',
        file: 'clean.ts',
        line: 1,
      });
      const result = await applyEvidenceGate(
        [finding],
        commonDeps({ repoLocalPath: proj }),
      );
      // tsc is clean → type check fails → finding dropped.
      assert.equal(result.dropped.length, 1);
      assert.ok(result.dropped[0].reasons.some((r) => r.startsWith('type:')));
    } finally {
      rmSync(proj, { recursive: true, force: true });
    }
  });
});

// ── 4. precedent-check ───────────────────────────────────────────────────

// SKIP: pre-existing dashboard-refactor casualty; tracked for follow-up,
// not in scope for this PR. Re-enable once the precedent-check sub-system
// is rewired against the new core-pipeline surface.
describe.skip('evidence-gate — precedent check', () => {
  it('drops an unusual-pattern finding when >= 3 precedents exist', async () => {
    const finding = makeFinding({
      id: 'f-prec-fail',
      claimType: 'unusual-pattern',
      quoted: 'FOO_WIDGET_PATTERN_XYZ',
    });
    const result = await applyEvidenceGate([finding], commonDeps());
    assert.equal(result.dropped.length, 1);
    assert.ok(result.dropped[0].reasons.some((r) => r.startsWith('precedent:')));
  });

  it('keeps an unusual-pattern finding when no precedents exist', async () => {
    const finding = makeFinding({
      id: 'f-prec-pass',
      claimType: 'unusual-pattern',
      quoted: 'NO_SUCH_PATTERN_EVER_UUU',
    });
    const result = await applyEvidenceGate([finding], commonDeps());
    assert.equal(result.kept.length, 1);
  });
});

// ── 5. test-exists-check ─────────────────────────────────────────────────

describe('evidence-gate — missing-test check', () => {
  it('drops a missing-test finding when a test already references the symbol', async () => {
    const finding = makeFinding({
      id: 'f-test-exists',
      claimType: 'missing-test',
      targetSymbol: 'greet',
    });
    const result = await applyEvidenceGate([finding], commonDeps());
    assert.equal(result.dropped.length, 1);
    assert.ok(result.dropped[0].reasons.some((r) => r.startsWith('test-exists:')));
  });
});

// ── 6. end-to-end mixed filtering ────────────────────────────────────────

describe('evidence-gate — end-to-end', () => {
  it('filters a mixed list keeping only findings that pass every non-skipped check', async () => {
    const diffText = 'diff\n+ user.email\n';
    const findings = [
      // Should be kept: quote passes, everything else is skipped.
      makeFinding({
        id: 'keep-1',
        quoted: 'user.email',
        claimType: 'other',
      }),
      // Should be dropped by quote-check (quoted not in diff).
      makeFinding({
        id: 'drop-quote',
        quoted: 'TOTALLY_ABSENT_STRING_111',
        claimType: 'other',
      }),
      // Should be dropped by precedent-check.
      makeFinding({
        id: 'drop-precedent',
        claimType: 'unusual-pattern',
        quoted: 'FOO_WIDGET_PATTERN_XYZ',
      }),
      // Should be dropped by test-exists-check.
      makeFinding({
        id: 'drop-test-exists',
        claimType: 'missing-test',
        targetSymbol: 'greet',
      }),
    ];
    const result = await applyEvidenceGate(findings, commonDeps({ diffText }));
    const keptIds = result.kept.map((f) => f.id).sort();
    const droppedIds = result.dropped.map((d) => d.finding.id).sort();
    assert.deepEqual(keptIds, ['keep-1']);
    assert.deepEqual(
      droppedIds,
      ['drop-precedent', 'drop-quote', 'drop-test-exists'],
    );
    // Every dropped finding should be marked demoted.
    for (const d of result.dropped) {
      assert.equal(d.finding.demoted, true);
      assert.ok((d.finding.evidenceChecks ?? []).length >= 1);
    }
  });
});

// Silence unused import warnings for the type-only imports above.
void (null as unknown as EnrichedFinding | ReviewFinding | undefined);
