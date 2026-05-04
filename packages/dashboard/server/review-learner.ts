/**
 * review-learner — learns from reviewer overrides to reduce false positives.
 *
 * Every time a human dismisses a finding or overrides a verdict, we record
 * the signal. Aggregated into project-level learnings that are injected into
 * the next reviewer's prompt — "in this project, findings of type X on file Y
 * have been dismissed 4/4 times; skip unless high-confidence."
 */

import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Category, Persona, Review, ReviewFinding, Resolution, Severity } from './review-store.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface ReviewLearningEvent {
  project: string;
  reviewId: string;
  reviewedAt: string;
  finding: ReviewFinding;
  resolution: Resolution;
  userOverride?: {
    verdictBefore: 'approve' | 'request-changes' | 'comment';
    verdictAfter: 'approve' | 'request-changes' | 'comment';
  };
}

export interface ReviewLearnings {
  project: string;
  updatedAt: string;
  reviewsSeen: number;
  findingsSeen: number;

  /** Per-category false-positive rates (dismissed / total seen). */
  falsePositiveByCategory: Record<Category, { seen: number; dismissed: number; rate: number }>;

  /** Per-persona calibration (dismissed / total). */
  falsePositiveByPersona: Record<Persona, { seen: number; dismissed: number; rate: number }>;

  /** Files where findings are consistently ignored (rate >= 0.75 with n >= 3). */
  noisyFiles: Array<{ file: string; repo: string | null; dismissRate: number; samples: number }>;

  /** Severity drift — how often users "downgrade" a finding via won't-fix. */
  severityOverrides: Record<Severity, { seen: number; wontFix: number }>;

  /** Top dismissed phrases — short keywords from descriptions, cluster-friendly. */
  dismissedKeywords: Array<{ phrase: string; count: number }>;

  /** Verdict overrides — did the reviewer change the verdict? (useful for gate calibration) */
  verdictOverrides: { seen: number; changed: number; softened: number; hardened: number };
}

// ── Helpers ──────────────────────────────────────────────────────────────

const MIN_SAMPLES = 3;
const NOISY_THRESHOLD = 0.75;

function atomicWriteJson(path: string, data: unknown): void {
  if (!existsSync(dirname(path))) mkdirSync(dirname(path), { recursive: true });
  const tmp = path + '.tmp';
  writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
  renameSync(tmp, path);
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try { return JSON.parse(readFileSync(path, 'utf-8')) as T; } catch { return null; }
}

function learningsPath(anvilHome: string, project: string): string {
  return join(anvilHome, 'projects', project, 'review-learnings.json');
}

function rawPath(anvilHome: string, project: string): string {
  return join(anvilHome, 'projects', project, 'review-learnings-raw.json');
}

interface RawLearnings {
  reviews: number;
  findings: number;
  byCategory: Record<string, { seen: number; dismissed: number }>;
  byPersona: Record<string, { seen: number; dismissed: number }>;
  byFile: Record<string, { seen: number; dismissed: number; repo: string | null }>;
  bySeverity: Record<string, { seen: number; wontFix: number }>;
  keywords: Record<string, number>;
  verdicts: { seen: number; changed: number; softened: number; hardened: number };
}

function emptyRaw(): RawLearnings {
  return {
    reviews: 0, findings: 0,
    byCategory: {}, byPersona: {}, byFile: {}, bySeverity: {},
    keywords: {},
    verdicts: { seen: 0, changed: 0, softened: 0, hardened: 0 },
  };
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Record a single resolution event (called when `setResolution` lands).
 * Call once per user-initiated change. Safe to call on startup to backfill.
 */
export function recordResolution(
  anvilHome: string,
  project: string,
  review: Review,
  finding: ReviewFinding,
  prevResolution: Resolution,
): ReviewLearnings {
  const raw = readJson<RawLearnings>(rawPath(anvilHome, project)) ?? emptyRaw();

  // Only count the transition once — ignore repeated same-state sets.
  if (prevResolution === finding.resolution) return distill(raw, project);

  // First-time resolution of this finding counts toward "seen".
  const firstTime = prevResolution === 'pending';
  if (firstTime) {
    raw.findings += 1;
    incr(raw.byCategory, finding.category, 'seen');
    if (finding.persona) incr(raw.byPersona, finding.persona, 'seen');
    incr(raw.bySeverity, finding.severity, 'seen');
    const fileKey = finding.file ? `${review.pr.repo}::${finding.file}` : '';
    if (fileKey) {
      const entry = (raw.byFile[fileKey] ??= { seen: 0, dismissed: 0, repo: review.pr.repo });
      entry.seen += 1;
    }
  }

  const isDismissed = finding.resolution === 'dismissed';
  const isWontFix = finding.resolution === 'wont-fix';

  if (isDismissed) {
    incr(raw.byCategory, finding.category, 'dismissed');
    if (finding.persona) incr(raw.byPersona, finding.persona, 'dismissed');
    const fileKey = finding.file ? `${review.pr.repo}::${finding.file}` : '';
    if (fileKey) {
      const entry = (raw.byFile[fileKey] ??= { seen: 0, dismissed: 0, repo: review.pr.repo });
      entry.dismissed += 1;
    }
    // Lightweight keyword extraction: first 3 words of description, lowercased.
    const phrase = extractKeywords(finding.description);
    if (phrase) raw.keywords[phrase] = (raw.keywords[phrase] ?? 0) + 1;
  }

  if (isWontFix) {
    incr(raw.bySeverity, finding.severity, 'wontFix');
  }

  atomicWriteJson(rawPath(anvilHome, project), raw);
  const learnings = distill(raw, project);
  atomicWriteJson(learningsPath(anvilHome, project), learnings);
  return learnings;
}

/** Call once per Review after it's created — just counts "reviews seen". */
export function recordReviewCreated(anvilHome: string, project: string): void {
  const raw = readJson<RawLearnings>(rawPath(anvilHome, project)) ?? emptyRaw();
  raw.reviews += 1;
  atomicWriteJson(rawPath(anvilHome, project), raw);
  atomicWriteJson(learningsPath(anvilHome, project), distill(raw, project));
}

/** Load the distilled learnings (or null if none exist yet). */
export function loadLearnings(anvilHome: string, project: string): ReviewLearnings | null {
  return readJson<ReviewLearnings>(learningsPath(anvilHome, project));
}

/**
 * Render learnings into a concise prompt block that can be injected into
 * reviewer agent prompts. Returns '' if there's not enough signal yet.
 */
export function formatLearningsForPrompt(anvilHome: string, project: string): string {
  const l = loadLearnings(anvilHome, project);
  if (!l || l.reviewsSeen < 2) return '';

  const lines: string[] = [];
  lines.push('## Review calibration (from this project\'s history)');
  lines.push(`Reviews seen: ${l.reviewsSeen} · findings seen: ${l.findingsSeen}.`);

  const noisyCats = Object.entries(l.falsePositiveByCategory)
    .filter(([, v]) => v.seen >= MIN_SAMPLES && v.rate >= 0.5);
  if (noisyCats.length) {
    lines.push('**Categories with high dismissal rates — be stricter with confidence:**');
    for (const [cat, v] of noisyCats) {
      lines.push(`- ${cat}: ${(v.rate * 100).toFixed(0)}% dismissed (${v.dismissed}/${v.seen})`);
    }
  }

  if (l.noisyFiles.length) {
    lines.push('**Files where findings are usually ignored — only flag high-severity issues:**');
    for (const f of l.noisyFiles.slice(0, 10)) {
      lines.push(`- \`${f.file}\`${f.repo ? ` (${f.repo})` : ''}: ${(f.dismissRate * 100).toFixed(0)}% dismissed (${f.samples} samples)`);
    }
  }

  if (l.dismissedKeywords.length) {
    lines.push('**Common dismissed phrases — avoid re-raising these unless evidence is strong:**');
    for (const k of l.dismissedKeywords.slice(0, 10)) {
      lines.push(`- "${k.phrase}" (${k.count}×)`);
    }
  }

  return lines.join('\n');
}

// ── Internals ───────────────────────────────────────────────────────────

function incr(bucket: Record<string, { seen?: number; dismissed?: number; wontFix?: number }>,
              key: string,
              field: 'seen' | 'dismissed' | 'wontFix'): void {
  const entry = (bucket[key] ??= {});
  entry[field] = ((entry[field] ?? 0) as number) + 1;
}

function extractKeywords(description: string): string | null {
  const words = description
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 3 && !STOPWORDS.has(w));
  if (words.length < 2) return null;
  return words.slice(0, 3).join(' ');
}

const STOPWORDS = new Set([
  'this', 'that', 'with', 'from', 'should', 'would', 'could', 'have', 'been',
  'will', 'also', 'your', 'when', 'then', 'than', 'into', 'some',
  'using', 'only', 'type', 'file', 'line', 'name', 'code',
]);

function distill(raw: RawLearnings, project: string): ReviewLearnings {
  const categories: ReviewLearnings['falsePositiveByCategory'] = {
    correctness: { seen: 0, dismissed: 0, rate: 0 },
    security: { seen: 0, dismissed: 0, rate: 0 },
    convention: { seen: 0, dismissed: 0, rate: 0 },
    test: { seen: 0, dismissed: 0, rate: 0 },
    perf: { seen: 0, dismissed: 0, rate: 0 },
    docs: { seen: 0, dismissed: 0, rate: 0 },
    'plan-drift': { seen: 0, dismissed: 0, rate: 0 },
  };
  for (const [cat, v] of Object.entries(raw.byCategory)) {
    if (cat in categories) {
      const entry = categories[cat as Category];
      entry.seen = v.seen ?? 0;
      entry.dismissed = v.dismissed ?? 0;
      entry.rate = entry.seen ? entry.dismissed / entry.seen : 0;
    }
  }

  const personas: ReviewLearnings['falsePositiveByPersona'] = {
    architect: { seen: 0, dismissed: 0, rate: 0 },
    security: { seen: 0, dismissed: 0, rate: 0 },
    style: { seen: 0, dismissed: 0, rate: 0 },
    tester: { seen: 0, dismissed: 0, rate: 0 },
    domain: { seen: 0, dismissed: 0, rate: 0 },
  };
  for (const [p, v] of Object.entries(raw.byPersona)) {
    if (p in personas) {
      const entry = personas[p as Persona];
      entry.seen = v.seen ?? 0;
      entry.dismissed = v.dismissed ?? 0;
      entry.rate = entry.seen ? entry.dismissed / entry.seen : 0;
    }
  }

  const noisyFiles: ReviewLearnings['noisyFiles'] = [];
  for (const [key, v] of Object.entries(raw.byFile)) {
    if (v.seen < MIN_SAMPLES) continue;
    const rate = v.dismissed / v.seen;
    if (rate < NOISY_THRESHOLD) continue;
    const [repo, ...pathParts] = key.split('::');
    noisyFiles.push({
      file: pathParts.join('::'),
      repo: v.repo ?? repo ?? null,
      dismissRate: rate,
      samples: v.seen,
    });
  }
  noisyFiles.sort((a, b) => b.dismissRate - a.dismissRate);

  const severities: ReviewLearnings['severityOverrides'] = {
    blocker: { seen: 0, wontFix: 0 },
    error: { seen: 0, wontFix: 0 },
    warn: { seen: 0, wontFix: 0 },
    info: { seen: 0, wontFix: 0 },
    nit: { seen: 0, wontFix: 0 },
  };
  for (const [s, v] of Object.entries(raw.bySeverity)) {
    if (s in severities) {
      const entry = severities[s as Severity];
      entry.seen = v.seen ?? 0;
      entry.wontFix = v.wontFix ?? 0;
    }
  }

  const dismissedKeywords: ReviewLearnings['dismissedKeywords'] =
    Object.entries(raw.keywords)
      .filter(([, c]) => c >= 2)
      .map(([phrase, count]) => ({ phrase, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 50);

  return {
    project,
    updatedAt: new Date().toISOString(),
    reviewsSeen: raw.reviews,
    findingsSeen: raw.findings,
    falsePositiveByCategory: categories,
    falsePositiveByPersona: personas,
    noisyFiles: noisyFiles.slice(0, 30),
    severityOverrides: severities,
    dismissedKeywords,
    verdictOverrides: { ...raw.verdicts },
  };
}
