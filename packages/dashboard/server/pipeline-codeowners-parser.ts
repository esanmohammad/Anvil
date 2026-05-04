/**
 * GitHub-style CODEOWNERS parser and matcher.
 *
 * Rules are evaluated in REVERSE file order: the last matching rule in the
 * file wins, mirroring GitHub's own semantics. Globs support `*`, `**`, `?`,
 * trailing `/` (directory), and leading `/` (anchor to repo root).
 *
 * `resolveGroups` expands group tags (e.g. `@security-team`) into their
 * member usernames using a lookup table passed by the caller.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  CodeownersRule,
  ReviewerGroup,
} from './pipeline-reviewers-types.js';

// ── Parse ────────────────────────────────────────────────────────────────

/**
 * Parse CODEOWNERS text into ordered rules. Blank lines and `#` comments
 * are ignored. Trailing/side comments (`pattern @u  # note`) are stripped.
 * Rules are returned in file order — the matcher iterates in reverse.
 */
export function parseCodeowners(text: string): CodeownersRule[] {
  const rules: CodeownersRule[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    // Strip side comments while respecting escaped `#` (rare but legal).
    const line = stripInlineComment(rawLine).trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) continue;
    const pattern = parts[0]!;
    const owners = parts.slice(1).filter((o) => o.startsWith('@') || o.includes('@'));
    if (!pattern || owners.length === 0) continue;
    rules.push({ pattern, owners });
  }
  return rules;
}

function stripInlineComment(line: string): string {
  let out = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (c === '#' && (i === 0 || line[i - 1] !== '\\')) break;
    out += c;
  }
  return out.replace(/\\#/g, '#');
}

// ── Match ────────────────────────────────────────────────────────────────

/**
 * Return the owners of the last matching rule for `filePath`, or `[]` if
 * no rule matches. Iterates in reverse to honor CODEOWNERS semantics.
 */
export function findOwners(
  rules: CodeownersRule[],
  filePath: string,
): string[] {
  const normalized = normalizePath(filePath);
  for (let i = rules.length - 1; i >= 0; i--) {
    const rule = rules[i]!;
    if (matchPattern(rule.pattern, normalized)) {
      return [...rule.owners];
    }
  }
  return [];
}

function normalizePath(p: string): string {
  let out = p.replace(/\\/g, '/');
  // Drop leading './'
  if (out.startsWith('./')) out = out.slice(2);
  // Drop leading '/' for the purposes of matching (we re-add anchoring logic).
  // We keep anchored matching separate below.
  return out;
}

/**
 * Match a CODEOWNERS glob pattern against a normalized path (no leading '/').
 * Supports `*`, `**`, `?`, trailing `/` (directory), and leading `/`
 * (root-anchored).
 */
export function matchPattern(pattern: string, path: string): boolean {
  let pat = pattern;

  // Directory rule: 'docs/' matches anything under 'docs/'.
  const isDirectory = pat.endsWith('/');
  if (isDirectory) pat = pat + '**';

  // Anchoring: leading '/' pins the pattern to the repo root. Without it,
  // the pattern can match at any depth ("match anywhere").
  let anchored = false;
  if (pat.startsWith('/')) {
    anchored = true;
    pat = pat.slice(1);
  }

  const regex = globToRegex(pat, anchored);
  return regex.test(path);
}

function globToRegex(pattern: string, anchored: boolean): RegExp {
  // Tokenize into segments that we translate separately.
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        // '**' → any chars including '/'
        re += '.*';
        i++;
      } else {
        // '*' → any chars except '/'
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '.' || c === '+' || c === '(' || c === ')' ||
               c === '|' || c === '^' || c === '$' || c === '{' ||
               c === '}' || c === '[' || c === ']' || c === '\\') {
      re += '\\' + c;
    } else {
      re += c;
    }
  }

  if (anchored) {
    return new RegExp('^' + re + '$');
  }
  // Non-anchored rules match anywhere in the path; either at root or after
  // any directory boundary.
  return new RegExp('(^|/)' + re + '$');
}

// ── Load ─────────────────────────────────────────────────────────────────

const CODEOWNERS_LOCATIONS = [
  '.github/CODEOWNERS',
  'CODEOWNERS',
  'docs/CODEOWNERS',
];

/** Try the canonical CODEOWNERS locations in order. Returns [] if none exist. */
export function loadCodeowners(repoLocalPath: string): CodeownersRule[] {
  for (const rel of CODEOWNERS_LOCATIONS) {
    const p = join(repoLocalPath, rel);
    if (existsSync(p)) {
      try {
        return parseCodeowners(readFileSync(p, 'utf-8'));
      } catch {
        // fall through to next candidate
      }
    }
  }
  return [];
}

// ── Group resolution ────────────────────────────────────────────────────

/**
 * Expand group tags into their member users. Individual `@user` entries
 * pass through unchanged. Result is deduplicated while preserving order.
 */
export function resolveGroups(
  owners: string[],
  groups: ReviewerGroup[],
): string[] {
  const index = new Map<string, ReviewerGroup>();
  for (const g of groups) index.set(g.tag, g);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const owner of owners) {
    const group = index.get(owner);
    const candidates = group ? group.users : [owner];
    for (const u of candidates) {
      if (!seen.has(u)) {
        seen.add(u);
        out.push(u);
      }
    }
  }
  return out;
}
