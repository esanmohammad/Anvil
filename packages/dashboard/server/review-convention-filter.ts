/**
 * review-convention-filter — Review Phase R6.
 *
 * Drops or demotes review findings that contradict detected project
 * conventions. A "convention" here is a preference recorded on a
 * ConventionsFingerprint (quotes, semicolons, indent, naming case, import
 * order, error style, …) with a confidence value. If a finding argues
 * against a convention the project has clearly adopted (confidence ≥ 0.7),
 * it is almost always noise: either drop it outright, or demote its
 * severity and mark it `demoted: true` so the verdict synthesizer still
 * sees the signal without blocking on it.
 *
 * Pure / stateless / no I/O. Designed to sit between the evidence gate and
 * verdict synthesis in `review-publisher.ts`.
 */

// ── Public types ─────────────────────────────────────────────────────────

export interface ConventionFilterReport {
  kept: unknown[];
  demoted: unknown[]; // confidence drop, severity lowered
  dropped: Array<{ finding: unknown; rule: string; detail: string }>;
}

export interface ConventionRule {
  id: string; // e.g. "no-semicolons"
  pattern: RegExp; // finding text to match
  confidence: number; // 0..1 — how sure we are this is the project's convention
  action: 'drop' | 'demote';
}

// ── Internal types ───────────────────────────────────────────────────────

type Severity = 'blocker' | 'high' | 'medium' | 'low' | 'info' | 'nit';

interface KnownPreference {
  key: string;
  value: string;
  confidence: number;
}

// Severity downgrade ordering. A "demoted" finding drops one level along
// this chain. Unknown severities are left untouched.
const SEVERITY_CHAIN: Severity[] = [
  'blocker',
  'high',
  'medium',
  'low',
  'info',
  'nit',
];

// Severity aliases we sometimes see from upstream findings.
const SEVERITY_ALIASES: Record<string, Severity> = {
  blocker: 'blocker',
  critical: 'blocker',
  error: 'high',
  high: 'high',
  warn: 'medium',
  warning: 'medium',
  medium: 'medium',
  low: 'low',
  info: 'info',
  nit: 'nit',
};

const DEMOTE_THRESHOLD = 0.7; // ≥ this → drop; between 0.5 and this → demote.
const DEMOTE_LOWER_BOUND = 0.5; // < this → no rule emitted at all.

// ── Rule patterns per fingerprint key ────────────────────────────────────

/**
 * For each well-known fingerprint key, we know how to turn a detected
 * value into a regex matching findings that argue *against* that value.
 * The returned `id` is stable and human-readable.
 */
function patternsForPreference(pref: KnownPreference): Array<{
  id: string;
  pattern: RegExp;
}> {
  const { key, value } = pref;
  const out: Array<{ id: string; pattern: RegExp }> = [];

  switch (key) {
    case 'semicolons': {
      if (value === 'always' || value === 'true' || value === 'on') {
        out.push({
          id: 'uses-semicolons',
          pattern: /\b(remove|drop|omit|no)\s+semicolons?\b|missing\s+semicolons?\s+(is|are)\s+(preferred|ok|fine)/i,
        });
      } else if (value === 'never' || value === 'false' || value === 'off') {
        out.push({
          id: 'no-semicolons',
          pattern: /\b(add|insert|should\s+use|missing)\s+semicolons?\b/i,
        });
      }
      break;
    }
    case 'quotes': {
      if (value === 'single') {
        out.push({
          id: 'single-quotes',
          pattern: /\b(use|prefer|should\s+use|switch\s+to)\s+double\s+quotes?\b/i,
        });
      } else if (value === 'double') {
        out.push({
          id: 'double-quotes',
          pattern: /\b(use|prefer|should\s+use|switch\s+to)\s+single\s+quotes?\b/i,
        });
      }
      break;
    }
    case 'indent': {
      if (value === 'tab' || value === 'tabs') {
        out.push({
          id: 'indent-tabs',
          pattern: /\b(use|should\s+use|prefer|switch\s+to)\s+spaces?\s+(for\s+)?indent/i,
        });
      } else if (value === 'space' || value === 'spaces' || /^\d+$/.test(value)) {
        out.push({
          id: 'indent-spaces',
          pattern: /\b(use|should\s+use|prefer|switch\s+to)\s+tabs?\s+(for\s+)?indent/i,
        });
      }
      break;
    }
    case 'namingCase': {
      if (value === 'camelCase') {
        out.push({
          id: 'naming-camelCase',
          pattern: /\b(use|should\s+use|prefer|switch\s+to)\s+(snake_case|PascalCase|kebab-case)\b/i,
        });
      } else if (value === 'snake_case') {
        out.push({
          id: 'naming-snake_case',
          pattern: /\b(use|should\s+use|prefer|switch\s+to)\s+(camelCase|PascalCase|kebab-case)\b/i,
        });
      } else if (value === 'PascalCase') {
        out.push({
          id: 'naming-PascalCase',
          pattern: /\b(use|should\s+use|prefer|switch\s+to)\s+(camelCase|snake_case|kebab-case)\b/i,
        });
      } else if (value === 'kebab-case') {
        out.push({
          id: 'naming-kebab-case',
          pattern: /\b(use|should\s+use|prefer|switch\s+to)\s+(camelCase|snake_case|PascalCase)\b/i,
        });
      }
      break;
    }
    case 'importOrder': {
      // Any non-empty detected order → push back on findings advocating for reordering.
      if (value && value !== 'unknown') {
        out.push({
          id: `import-order-${value}`,
          pattern: /\b(re-?order|sort|rearrange|group)\s+imports?\b/i,
        });
      }
      break;
    }
    case 'errorStyle': {
      if (value === 'throw') {
        out.push({
          id: 'errors-throw',
          pattern: /\b(return|prefer\s+returning|use\s+Result|use\s+Either)\s+(an?\s+)?errors?\b/i,
        });
      } else if (value === 'return' || value === 'result' || value === 'either') {
        out.push({
          id: 'errors-return',
          pattern: /\b(should\s+throw|throw\s+(an?\s+)?error)\b/i,
        });
      }
      break;
    }
    default:
      // Generic fallback: a detected string preference yields a literal
      // "should use <other>" pattern if the finding text contradicts the
      // current value. We don't know other values, so skip.
      break;
  }
  return out;
}

// ── Fingerprint introspection ────────────────────────────────────────────

const RECOGNIZED_KEYS = [
  'indent',
  'quotes',
  'semicolons',
  'namingCase',
  'importOrder',
  'errorStyle',
] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Extract `{ value, confidence }` from a fingerprint entry. We accept two
 * shapes:
 *   - a bare string (confidence defaults to 1.0), and
 *   - an object `{ value, confidence }` (or `{ value, score }`).
 */
function extractPreference(
  key: string,
  raw: unknown,
): KnownPreference | null {
  if (typeof raw === 'string' && raw.length > 0) {
    return { key, value: raw, confidence: 1 };
  }
  if (typeof raw === 'boolean') {
    return { key, value: raw ? 'true' : 'false', confidence: 1 };
  }
  if (typeof raw === 'number') {
    return { key, value: String(raw), confidence: 1 };
  }
  const rec = asRecord(raw);
  if (!rec) return null;
  const valueRaw = rec['value'];
  const value =
    typeof valueRaw === 'string'
      ? valueRaw
      : typeof valueRaw === 'number' || typeof valueRaw === 'boolean'
        ? String(valueRaw)
        : null;
  if (!value) return null;
  const confRaw = rec['confidence'] ?? rec['score'];
  let confidence = 1;
  if (typeof confRaw === 'number' && Number.isFinite(confRaw)) {
    confidence = Math.max(0, Math.min(1, confRaw));
  }
  return { key, value, confidence };
}

// ── Public: rule builder ─────────────────────────────────────────────────

export function buildConventionRules(fingerprint: unknown): ConventionRule[] {
  const rec = asRecord(fingerprint);
  if (!rec) return [];

  const rules: ConventionRule[] = [];
  for (const key of RECOGNIZED_KEYS) {
    if (!(key in rec)) continue;
    const pref = extractPreference(key, rec[key]);
    if (!pref) continue;
    if (pref.confidence < DEMOTE_LOWER_BOUND) continue;

    const action: ConventionRule['action'] =
      pref.confidence >= DEMOTE_THRESHOLD ? 'drop' : 'demote';

    for (const patt of patternsForPreference(pref)) {
      rules.push({
        id: patt.id,
        pattern: patt.pattern,
        confidence: pref.confidence,
        action,
      });
    }
  }
  return rules;
}

// ── Public: filter ───────────────────────────────────────────────────────

function findingMessage(finding: unknown): string {
  const rec = asRecord(finding);
  if (!rec) return '';
  const msg = rec['message'] ?? rec['description'] ?? rec['text'];
  return typeof msg === 'string' ? msg : '';
}

function findingSeverity(finding: unknown): Severity | null {
  const rec = asRecord(finding);
  if (!rec) return null;
  const s = rec['severity'];
  if (typeof s !== 'string') return null;
  const alias = SEVERITY_ALIASES[s.toLowerCase()];
  return alias ?? null;
}

function demoteSeverity(sev: Severity): Severity {
  const idx = SEVERITY_CHAIN.indexOf(sev);
  if (idx < 0) return sev;
  const next = SEVERITY_CHAIN[Math.min(idx + 1, SEVERITY_CHAIN.length - 1)];
  return next;
}

function demoteFinding(finding: unknown): unknown {
  const rec = asRecord(finding);
  if (!rec) return finding;
  const sev = findingSeverity(finding);
  const clone: Record<string, unknown> = { ...rec, demoted: true };
  if (sev) clone['severity'] = demoteSeverity(sev);
  // Lower confidence by one "notch" if present.
  const conf = rec['confidence'];
  if (typeof conf === 'number' && Number.isFinite(conf)) {
    clone['confidence'] = Math.max(0, conf - 0.25);
  } else if (conf === 'high') clone['confidence'] = 'med';
  else if (conf === 'med' || conf === 'medium') clone['confidence'] = 'low';
  return clone;
}

export function applyConventionFilter(
  findings: unknown[],
  fingerprint: unknown,
): ConventionFilterReport {
  const rules = buildConventionRules(fingerprint);
  const report: ConventionFilterReport = {
    kept: [],
    demoted: [],
    dropped: [],
  };

  if (rules.length === 0) {
    for (const f of findings) report.kept.push(f);
    return report;
  }

  for (const finding of findings) {
    const msg = findingMessage(finding);
    if (!msg) {
      report.kept.push(finding);
      continue;
    }

    // Evaluate all rules; drop beats demote. Collect every matching rule
    // so we can report the most informative one.
    let dropRule: ConventionRule | null = null;
    const demoteRules: ConventionRule[] = [];
    for (const rule of rules) {
      if (!rule.pattern.test(msg)) continue;
      if (rule.action === 'drop') {
        if (!dropRule || rule.confidence > dropRule.confidence) {
          dropRule = rule;
        }
      } else {
        demoteRules.push(rule);
      }
    }

    if (dropRule) {
      report.dropped.push({
        finding,
        rule: dropRule.id,
        detail: `contradicts detected convention (confidence ${dropRule.confidence.toFixed(2)})`,
      });
      continue;
    }
    if (demoteRules.length > 0) {
      // Demote once, even if multiple rules fire — one severity notch.
      report.demoted.push(demoteFinding(finding));
      continue;
    }
    report.kept.push(finding);
  }

  return report;
}
