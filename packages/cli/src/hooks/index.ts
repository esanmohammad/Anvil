// Barrel export for hooks module

// Section A — Language Detection & Tool Resolution
export { Language, detectLanguage } from './lang/detect.js';
export { resolveTools } from './lang/tools.js';
export type { ToolSet } from './lang/tools.js';
export { checkBinary } from './lang/binary-check.js';

// Section B — Formatter
export { runFormatter } from './format/runner.js';
export type { FormatResult } from './format/runner.js';

// Section C — Linter
export { runLinter } from './lint/runner.js';
export type { LintResult } from './lint/runner.js';
export { parseGolangciLint, parseEslint, parseRuff } from './lint/parsers.js';
export type { LintIssue } from './lint/parsers.js';

// Section D — Diff Scanner
export { getFileDiff } from './diff/extractor.js';
export type { FileDiff, DiffHunk, DiffLine } from './diff/extractor.js';
export { matchDenyPatterns } from './diff/deny-matcher.js';
export type { DenyMatch } from './diff/deny-matcher.js';
export { checkRequirePatterns } from './diff/require-checker.js';
export type { RequireViolation } from './diff/require-checker.js';
export { scanDiff } from './diff/scanner.js';
export type { ScanResult, ScanOptions } from './diff/scanner.js';

// Section E — Convention Rules
export type {
  EnforcementLevel,
  DenyPattern,
  RequirePattern,
  ConventionRules,
  ConventionViolation,
} from './convention/types.js';
export { loadConventionRules } from './convention/loader.js';
export { loadEnforcementConfig, getEffectiveLevel, applyEnforcement } from './convention/enforcement.js';

// Section F — Exemplar
export type { Exemplar, ExemplarQuery, ExemplarCache } from './exemplar/types.js';
export { searchCodebase } from './exemplar/mcp-client.js';
export { ExemplarDiskCache } from './exemplar/cache.js';
export { fetchExemplar } from './exemplar/fetcher.js';

// Section G — Convention Formatter
export { formatViolation, formatViolations } from './convention/formatter.js';

// Section H — Commands & CLI
export { runFormatCommand } from './commands/format.js';
export { runLintCommand } from './commands/lint.js';
export { runConventionCommand } from './commands/convention.js';
export { runCheckCommand } from './commands/check.js';
export type { CheckResult } from './commands/check.js';
export { createHookCli } from './cli.js';

// Section I — Hook Configuration
export type { ClaudeHook, HookMatcher, HookConfig } from './config/types.js';
export { generateHookConfig } from './config/generator.js';
export { installHooks, removeHooks } from './config/installer.js';
export { HookLifecycle } from './config/lifecycle.js';

// Section J — Output
export { JsonReporter } from './output/json-reporter.js';
export { TextReporter } from './output/text-reporter.js';
