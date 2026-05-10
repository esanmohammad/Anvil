#!/usr/bin/env node
/**
 * Phase F7 — `npm run lint:stages` driver.
 *
 * Walks the configured globs, runs the durable-execution linter
 * (lintStepSource) over each file, prints violations to stderr.
 *
 * Default mode: ADVISORY. Prints violations but exits 0. Catches
 * regressions in code review without blocking the build for
 * grandfathered cases (e.g. telemetry intentionally outside the
 * durable log per durable-execution-plan §O).
 *
 * Strict mode: set `ANVIL_LINT_STAGES_STRICT=1` to exit non-zero
 * on any violation. Wire this into CI for the surface that should
 * stay clean (e.g. dashboard/server/pipeline-stages.ts).
 *
 * Usage:
 *   node scripts/lint-stages.js [path...]
 *
 * Default targets (when no args supplied):
 *   - packages/core-pipeline/src/stages/**\/*.ts
 *   - packages/core-pipeline/src/steps/**\/*.ts
 *   - packages/dashboard/server/pipeline-stages.ts
 *
 * Env:
 *   ANVIL_LINT_STAGES_OFF=1     — skip entirely (exit 0 immediately).
 *   ANVIL_LINT_STAGES_STRICT=1  — fail the run on any violation.
 */

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, join, resolve, extname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { lintStepSource } from '../dist/durable/lint.js';

const __filename = fileURLToPath(import.meta.url);
const REPO_ROOT = resolve(dirname(__filename), '..', '..', '..');

const DEFAULT_TARGETS = [
  'packages/core-pipeline/src/stages',
  'packages/core-pipeline/src/steps',
  'packages/dashboard/server/pipeline-stages.ts',
];

function walkTs(target) {
  const abs = resolve(REPO_ROOT, target);
  if (!existsSync(abs)) return [];
  const st = statSync(abs);
  if (st.isFile()) return extname(abs) === '.ts' ? [abs] : [];
  const out = [];
  for (const entry of readdirSync(abs)) {
    if (entry.startsWith('.')) continue;
    if (entry === 'node_modules' || entry === 'dist' || entry === 'out') continue;
    out.push(...walkTs(join(target, entry)));
  }
  return out;
}

function main() {
  if (process.env.ANVIL_LINT_STAGES_OFF === '1') {
    console.log('[lint-stages] ANVIL_LINT_STAGES_OFF=1 — skipping');
    process.exit(0);
  }
  const targets = process.argv.slice(2);
  const files = (targets.length > 0 ? targets : DEFAULT_TARGETS).flatMap(walkTs);

  let totalViolations = 0;
  let failedFiles = 0;
  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    const violations = lintStepSource(source);
    if (violations.length === 0) continue;
    failedFiles += 1;
    totalViolations += violations.length;
    const rel = relative(REPO_ROOT, file);
    console.error(`\n${rel}:`);
    for (const v of violations) {
      console.error(`  ${v.line}: ${v.match}  →  ${v.suggestion}  [${v.rule}]`);
    }
  }

  if (totalViolations === 0) {
    console.log(`[lint-stages] OK — ${files.length} file(s) clean`);
    process.exit(0);
  }
  const strict = process.env.ANVIL_LINT_STAGES_STRICT === '1';
  const summary = `[lint-stages] ${totalViolations} violation(s) across ${failedFiles} file(s). `
    + 'Wrap direct side effects in ctx.effect(name, fn) — see '
    + 'docs/durable-execution-plan.md §E.';
  if (strict) {
    console.error(`\n${summary}`);
    process.exit(1);
  }
  console.error(`\n${summary}`);
  console.error('[lint-stages] advisory mode — pass ANVIL_LINT_STAGES_STRICT=1 to fail on violations.');
  process.exit(0);
}

main();
