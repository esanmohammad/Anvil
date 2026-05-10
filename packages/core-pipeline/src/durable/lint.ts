/**
 * Static analyzer for the durable execution invariant
 * "no direct side effects in step bodies."
 *
 * Phase D5 of the durable execution rollout. Given the source of a
 * `*.step.ts` or `stages/*.ts` file, returns a list of disallowed
 * call patterns: `Date.now()`, `Math.random()`,
 * `crypto.randomUUID()`, `fs.writeFile*`, `child_process.exec*`,
 * `setTimeout` (use `ctx.sleep`).
 *
 * The analyzer is a regex-driven first-pass detector. False
 * positives are possible (e.g. comment lines, string literals);
 * the cure is to wrap real calls in `ctx.effect(...)`. The full
 * AST-based ESLint plugin is a v2 follow-up — this module ships
 * the rule fixtures + the CLI that surfaces violations to users.
 */

export interface LintViolation {
  /** 1-indexed line number. */
  line: number;
  /** The matched substring. */
  match: string;
  /** Stable rule id matching the docs. */
  rule:
    | 'no-direct-date-now'
    | 'no-direct-math-random'
    | 'no-direct-crypto-uuid'
    | 'no-direct-fs-write'
    | 'no-direct-fs-read'
    | 'no-direct-exec'
    | 'no-direct-setTimeout';
  /** Suggested replacement. */
  suggestion: string;
}

interface RuleSpec {
  rule: LintViolation['rule'];
  pattern: RegExp;
  suggestion: string;
}

// Negative lookbehind `(?<![.\w])` ensures we match bare calls
// (e.g. `exec("ls")`) and not method calls (e.g. `regex.exec(text)`)
// or property access on words (e.g. `someExec(`). Two-char lookbehind
// covers the common cases without needing variable-length groups.
const RULES: RuleSpec[] = [
  {
    rule: 'no-direct-date-now',
    pattern: /(?<![.\w])Date\.now\s*\(/g,
    suggestion: 'await ctx.now()',
  },
  {
    rule: 'no-direct-math-random',
    pattern: /(?<![.\w])Math\.random\s*\(/g,
    suggestion: 'await ctx.random()',
  },
  {
    rule: 'no-direct-crypto-uuid',
    pattern: /(?<![.\w])(?:randomUUID|crypto\.randomUUID)\s*\(/g,
    suggestion: 'await ctx.uuid()',
  },
  {
    rule: 'no-direct-fs-write',
    pattern: /(?<![.\w])(writeFile(?:Sync)?|appendFile(?:Sync)?)\s*\(/g,
    suggestion: 'wrap in ctx.effect(\'<name>\', () => writeFile(...))',
  },
  {
    rule: 'no-direct-fs-read',
    pattern: /(?<![.\w])(readFile(?:Sync)?)\s*\(/g,
    suggestion: 'wrap in ctx.effect(\'<name>\', () => readFile(...))',
  },
  {
    rule: 'no-direct-exec',
    pattern: /(?<![.\w])(exec(?:Sync|File|FileSync)?|spawn(?:Sync)?)\s*\(/g,
    suggestion: 'wrap in ctx.effect(\'<name>\', () => exec(...))',
  },
  {
    rule: 'no-direct-setTimeout',
    pattern: /(?<![.\w])setTimeout\s*\(/g,
    suggestion: 'await ctx.sleep(ms)',
  },
];

const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;

/**
 * Scan the given source text for violations of the no-direct-side-effects
 * rule set.
 *
 * Lines that begin with `//`, `*`, or `/*` are skipped to avoid
 * commenting-out false positives. Strings are not parsed — a
 * literal `"Date.now()"` will still surface; that's intentional
 * because review treats it as a code smell anyway.
 */
export function lintStepSource(source: string): LintViolation[] {
  const violations: LintViolation[] = [];
  const lines = source.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (COMMENT_LINE.test(line)) continue;
    for (const rule of RULES) {
      rule.pattern.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = rule.pattern.exec(line)) !== null) {
        violations.push({
          line: i + 1,
          match: m[0],
          rule: rule.rule,
          suggestion: rule.suggestion,
        });
      }
    }
  }
  return violations;
}
