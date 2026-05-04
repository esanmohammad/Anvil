// Synthesize structured ConventionRule[] from AggregatedConventions.
//
// Single source of truth: every dashboard / cli / review consumer reads
// the rules.json this writes via loadRules(). Confidence < MIN_CONFIDENCE
// is dropped so we never emit guesses.
//
// Two-pass synthesis:
//   1. Project-wide rules — emitted when ≥80% of repos agree (the
//      aggregator's threshold for promotion to `projectWide`).
//   2. Per-repo fallback — multi-repo projects (Go backend + TS frontend,
//      etc.) almost never hit 80% project-wide agreement, so we also
//      emit rules scoped to each repo's filePattern. Without this the
//      regenerate flow lands on 0 rules and looks broken.

import type { AggregatedConventions, RepoConventions } from './aggregator.js';
import type { FileNamingResult } from './detectors/file-naming.js';
import type { ImportPatternResult } from './detectors/import-patterns.js';
import type { TestPatternResult } from './detectors/test-patterns.js';
import type { ErrorHandlingResult } from './detectors/error-handling.js';
import type { ConventionRule } from './rules/types.js';

// Detectors return confidence as 0-100 (already a percent), NOT a 0-1
// fraction. Threshold is in the same units.
const MIN_CONFIDENCE = 60;

const NAMING_PATTERNS: Record<string, { deny: string; example: string }> = {
  'kebab-case':  { deny: '[A-Z_]', example: 'use-this-name.ts not UseThisName.ts' },
  'camelCase':   { deny: '[-_]',   example: 'useThisName.ts not use-this-name.ts' },
  'PascalCase':  { deny: '^[a-z]|[-_]', example: 'UseThisName.ts not useThisName.ts' },
  'snake_case':  { deny: '[A-Z-]', example: 'use_this_name.py not UseThisName.py' },
};

// ── Single-detector → rule emitters (pure; reused by both passes) ────────

interface Scope {
  /** Suffix appended to rule id to keep ids unique across project + repo passes. */
  idSuffix: string;
  /** Glob root applied in the rule's filePattern. */
  globRoot: string;
  /** Human-readable label for the description ("project" or "repo `foo`"). */
  label: string;
}

function fileNamingRule(r: FileNamingResult, scope: Scope): ConventionRule | null {
  if (r.confidence < MIN_CONFIDENCE) return null;
  if (r.convention === 'unknown') return null;
  const pattern = NAMING_PATTERNS[r.convention];
  if (!pattern) return null;
  return {
    id: `file-naming-${r.convention}${scope.idSuffix}`,
    name: `Use ${r.convention} for filenames`,
    description: `${r.confidence}% of files in ${scope.label} use ${r.convention}.`,
    severity: 'warning',
    filePattern: `${scope.globRoot}**/*.{ts,tsx,js,jsx,go,py,rs,java}`,
    deny: pattern.deny,
    message: `Rename to ${r.convention} (${pattern.example}).`,
    enabled: true,
  };
}

function importStyleRule(r: ImportPatternResult, scope: Scope): ConventionRule | null {
  if (r.confidence < MIN_CONFIDENCE) return null;
  if (r.style === 'absolute') {
    return {
      id: `import-style-absolute${scope.idSuffix}`,
      name: 'Use absolute imports',
      description: `${scope.label} favours absolute imports (${r.absoluteCount} vs ${r.relativeCount} relative).`,
      severity: 'info',
      filePattern: `${scope.globRoot}**/*.{ts,tsx,js,jsx}`,
      deny: "from\\s+['\"]\\.{1,2}/",
      message: 'Prefer absolute imports over relative paths.',
      enabled: true,
    };
  }
  if (r.style === 'relative') {
    return {
      id: `import-style-relative${scope.idSuffix}`,
      name: 'Use relative imports',
      description: `${scope.label} favours relative imports (${r.relativeCount} vs ${r.absoluteCount} absolute).`,
      severity: 'info',
      filePattern: `${scope.globRoot}**/*.{ts,tsx,js,jsx}`,
      message: 'Prefer relative imports for sibling modules.',
      enabled: true,
    };
  }
  return null;
}

function testPatternRule(r: TestPatternResult, scope: Scope): ConventionRule | null {
  if (r.confidence < MIN_CONFIDENCE) return null;
  if (r.suffix === 'mixed') return null;
  return {
    id: `test-suffix-${r.suffix.replace(/\./g, '')}${scope.idSuffix}`,
    name: `Use ${r.suffix} for test files`,
    description: `${scope.label}'s test convention: ${r.testFileCount} files matching ${r.suffix}.`,
    severity: 'warning',
    filePattern: `${scope.globRoot}**/*test*`,
    message: `Test files should match ${r.suffix}.`,
    enabled: true,
  };
}

function errorHandlingRule(r: ErrorHandlingResult, scope: Scope): ConventionRule | null {
  if (r.confidence < MIN_CONFIDENCE) return null;
  if (r.style === 'mixed') return null;
  const cap = r.style.charAt(0).toUpperCase() + r.style.slice(1);
  return {
    id: `error-handling-${r.style}${scope.idSuffix}`,
    name: `${cap} error handling`,
    description: `${scope.label} uses ${r.style} error handling consistently.`,
    severity: 'info',
    filePattern: `${scope.globRoot}**/*.{ts,tsx,js,jsx,go,rs}`,
    message: `Match ${scope.label}'s ${r.style} error-handling style.`,
    enabled: true,
  };
}

function pushIf<T>(arr: T[], v: T | null): void {
  if (v !== null) arr.push(v);
}

function repoScope(repo: RepoConventions): Scope {
  return {
    idSuffix: `--${repo.repoName}`,
    globRoot: `${repo.repoName}/`,
    label: `repo \`${repo.repoName}\``,
  };
}

const PROJECT_SCOPE: Scope = { idSuffix: '', globRoot: '', label: 'this project' };

export function synthesizeRules(agg: AggregatedConventions): ConventionRule[] {
  const rules: ConventionRule[] = [];

  const pw = agg.projectWide;
  if (pw.fileNaming)     pushIf(rules, fileNamingRule(pw.fileNaming, PROJECT_SCOPE));
  if (pw.imports)        pushIf(rules, importStyleRule(pw.imports, PROJECT_SCOPE));
  if (pw.tests)          pushIf(rules, testPatternRule(pw.tests, PROJECT_SCOPE));
  if (pw.errorHandling)  pushIf(rules, errorHandlingRule(pw.errorHandling, PROJECT_SCOPE));

  // Per-repo pass — only fires for detectors that didn't already produce
  // a project-wide rule, so multi-language repos still get coverage
  // without duplicating rules that already exist project-wide.
  const havePwFileNaming    = !!pw.fileNaming;
  const havePwImports       = !!pw.imports;
  const havePwTests         = !!pw.tests;
  const havePwErrorHandling = !!pw.errorHandling;

  for (const repo of agg.perRepo) {
    const scope = repoScope(repo);
    if (!havePwFileNaming)    pushIf(rules, fileNamingRule(repo.fileNaming, scope));
    if (!havePwImports)       pushIf(rules, importStyleRule(repo.imports, scope));
    if (!havePwTests)         pushIf(rules, testPatternRule(repo.tests, scope));
    if (!havePwErrorHandling) pushIf(rules, errorHandlingRule(repo.errorHandling, scope));
  }

  return rules;
}
