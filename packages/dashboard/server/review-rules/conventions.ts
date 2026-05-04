/**
 * Convention rules prepass — matches added diff lines against the
 * project's `enforced` convention rules stored in
 * `~/.anvil/projects/<project>/conventions.json`.
 *
 * Only `enforced` rules are considered (others are noisy suggestions).
 * Matching is case-insensitive substring against `avoidPattern`. Each
 * hit emits a ReviewFinding with category:'convention' / persona:'style'.
 *
 * OWASP mapping: N/A — these are style/correctness conventions, not
 * security controls.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  matchInAddedLines,
  snippet,
  type DiffInput,
  type ReviewFinding,
} from './helpers.js';

// ── Types ───────────────────────────────────────────────────────────────

export interface ConventionRule {
  id: string;
  description: string;
  /** Optional explicit severity. Defaults to 'warn'. */
  severity?: 'blocker' | 'error' | 'warn' | 'info' | 'nit';
  status?: 'detected' | 'validated' | 'enforced';
  /** Optional per-repo scoping — when set, rule only applies to files in this repo. */
  repo?: string;
  /** Free-text hint the added line must NOT contain (case-insensitive substring). */
  avoidPattern?: string;
}

export interface ConventionRulesDeps {
  anvilHome: string;
  project: string;
  /**
   * Optional helper that maps a repo-relative file path to the repo name.
   * Used to scope repo-specific rules. Returning null means "unknown" —
   * such rules will still match (fail open on scoping uncertainty).
   */
  repoByFile?: (filePath: string) => string | null;
}

// ── Loader ──────────────────────────────────────────────────────────────

function loadConventionRules(
  anvilHome: string,
  project: string,
): ConventionRule[] {
  const path = join(anvilHome, 'projects', project, 'conventions.json');
  if (!existsSync(path)) return [];
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (Array.isArray(raw)) return raw as ConventionRule[];
    if (
      raw &&
      typeof raw === 'object' &&
      Array.isArray((raw as { rules?: unknown }).rules)
    ) {
      return (raw as { rules: ConventionRule[] }).rules;
    }
    return [];
  } catch {
    return [];
  }
}

// ── Escape helper (literal substring → regex) ───────────────────────────

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── `no-any` helper ─────────────────────────────────────────────────────

function isNoAnyRule(rule: ConventionRule): boolean {
  if (rule.id === 'no-any') return true;
  const p = (rule.avoidPattern ?? '').trim().toLowerCase();
  // Match patterns like `: any`, `<any>`, or a bare "any".
  return p === 'any' || p === ': any' || p === '<any>';
}

/**
 * Build a suggestedFix that rewrites `: any` (and related forms) to
 * `: unknown`. The diff is illustrative, not a strictly applicable patch.
 */
function unknownFix(match: string): ReviewFinding['suggestedFix'] {
  const replaced = match
    .replace(/:\s*any\b/g, ': unknown')
    .replace(/<\s*any\s*>/g, '<unknown>')
    .replace(/\bany\[\]/g, 'unknown[]');
  return {
    diff: `- ${match}\n+ ${replaced}`,
    rationale:
      '`unknown` is type-safe; narrow with guards.',
  };
}

// ── Main entry point ────────────────────────────────────────────────────

export function runConventionRules(
  diff: DiffInput,
  deps: ConventionRulesDeps,
): ReviewFinding[] {
  const rules = loadConventionRules(deps.anvilHome, deps.project)
    .filter((r) => (r.status ?? 'detected') === 'enforced')
    .filter((r): r is ConventionRule & { avoidPattern: string } =>
      typeof r.avoidPattern === 'string' && r.avoidPattern.length > 0,
    );

  if (rules.length === 0) return [];

  const findings: ReviewFinding[] = [];

  for (const rule of rules) {
    // Case-insensitive substring match via regex.
    const regex = new RegExp(escapeRegex(rule.avoidPattern), 'i');
    const noAny = isNoAnyRule(rule);

    for (const hit of matchInAddedLines(diff, regex)) {
      // Scope by repo when the rule has one and we can identify the file's repo.
      if (rule.repo && deps.repoByFile) {
        const owning = deps.repoByFile(hit.file);
        if (owning && owning !== rule.repo) continue;
      }

      const finding: ReviewFinding = {
        severity: rule.severity ?? 'warn',
        category: 'convention',
        persona: 'style',
        file: hit.file,
        line: hit.lineNumber,
        snippet: snippet(hit.text),
        description:
          `Convention "${rule.description}" violated — line contains "${rule.avoidPattern}". (rule: ${rule.id})`,
        confidence: 'med',
        resolution: 'pending',
      };

      if (noAny) {
        finding.suggestedFix = unknownFix(hit.match[0]);
      }

      findings.push(finding);
    }
  }

  return findings;
}
