/** Slice SPECS.md down to just the sections referenced by a set of tasks. */

export interface SpecSection {
  /** Heading text without leading hashes/whitespace, e.g. "Data Model" */
  heading: string;
  /** 2 = "## ", 3 = "### ", etc. */
  level: number;
  /** Full body of the section, including the heading line and trailing content
   *  up to (but not including) the next heading at the same or shallower level. */
  body: string;
  /** Line number (1-indexed) where this section starts. */
  lineStart: number;
}

export interface SliceOptions {
  /** Max total bytes returned (default 25_000). When exceeded, sections later
   *  in the resolved order are dropped (not truncated mid-section). */
  maxBytes?: number;
  /** Always include the doc's leading "## Overview" section if present and
   *  not already in the slice. Default true. */
  includeOverview?: boolean;
}

export interface SliceResult {
  /** Concatenated section bodies, separated by `\n\n---\n\n`. Includes a small
   *  header line "## Spec slice (N sections)" at the top. Empty string when
   *  no refs resolve. */
  text: string;
  /** Refs that resolved to a section. */
  resolved: string[];
  /** Refs we couldn't match. */
  unresolved: string[];
  /** Bytes of `text`. */
  bytes: number;
}

const DEFAULT_MAX_BYTES = 25_000;
const HEADING_RE = /^(#{2,6})\s+(.+?)\s*$/;
const FENCE_RE = /^(```|~~~)/;

// ── Parsing ──────────────────────────────────────────────────────────────

/**
 * Parse all `## `/`### `/`#### ` headings and return a flat list of sections.
 * Code blocks (```...```) are respected — `#` inside a fenced code block is
 * not treated as a heading.
 */
export function parseSections(specsMd: string): SpecSection[] {
  const lines = specsMd.split('\n');
  const headings: { heading: string; level: number; lineStart: number; lineIndex: number }[] = [];

  let inFence = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    const m = HEADING_RE.exec(line);
    if (!m) continue;

    const hashes = m[1] ?? '';
    const text = (m[2] ?? '').trim();
    headings.push({
      heading: text,
      level: hashes.length,
      lineStart: i + 1,
      lineIndex: i,
    });
  }

  const sections: SpecSection[] = [];
  for (let h = 0; h < headings.length; h++) {
    const cur = headings[h]!;
    // Body runs until the next heading with level <= cur.level.
    let endLine = lines.length;
    for (let n = h + 1; n < headings.length; n++) {
      if (headings[n]!.level <= cur.level) {
        endLine = headings[n]!.lineIndex;
        break;
      }
    }
    const body = lines.slice(cur.lineIndex, endLine).join('\n').replace(/\s+$/, '');
    sections.push({
      heading: cur.heading,
      level: cur.level,
      body,
      lineStart: cur.lineStart,
    });
  }
  return sections;
}

// ── Matching ─────────────────────────────────────────────────────────────

function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/`/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(s: string): string[] {
  return normalize(s)
    .split(' ')
    .filter((t) => t.length >= 3);
}

/**
 * Find the section whose heading matches the given reference.
 *
 * Matching strategy (try in order, return first hit):
 *   1. Exact normalized-string match against any heading text
 *   2. The last "›"-separated segment matched against any heading text
 *   3. Substring match (normalized) — heading contains ref or ref contains heading
 *   4. Token-overlap fallback — at least 60% of ref's significant tokens
 *      must appear in the heading
 */
export function findSection(specsMd: string, ref: string): SpecSection | null {
  if (!ref || !ref.trim()) return null;
  const sections = parseSections(specsMd);
  if (sections.length === 0) return null;

  const refNorm = normalize(ref);

  // 1. Exact normalized match.
  for (const s of sections) {
    if (normalize(s.heading) === refNorm) return s;
  }

  // 2. Last "›"-separated segment.
  const parts = ref.split('›').map((p) => p.trim()).filter(Boolean);
  if (parts.length > 1) {
    const lastNorm = normalize(parts[parts.length - 1]!);
    for (const s of sections) {
      if (normalize(s.heading) === lastNorm) return s;
    }
  }

  // 3. Substring match (normalized).
  for (const s of sections) {
    const headNorm = normalize(s.heading);
    if (!headNorm) continue;
    if (headNorm.includes(refNorm) || refNorm.includes(headNorm)) return s;
  }

  // 4. Token-overlap fallback (>= 60% of ref's significant tokens in heading).
  const refTokens = tokens(ref);
  if (refTokens.length === 0) return null;
  let bestSection: SpecSection | null = null;
  let bestRatio = 0;
  for (const s of sections) {
    const headTokenSet = new Set(tokens(s.heading));
    if (headTokenSet.size === 0) continue;
    let hits = 0;
    for (const t of refTokens) {
      if (headTokenSet.has(t)) hits++;
    }
    const ratio = hits / refTokens.length;
    if (ratio >= 0.6 && ratio > bestRatio) {
      bestRatio = ratio;
      bestSection = s;
    }
  }
  return bestSection;
}

// ── Slicing ──────────────────────────────────────────────────────────────

/**
 * Build a compact spec slice covering the given Spec References. Deduplicates
 * sections and honours maxBytes.
 */
export function sliceSpecForRefs(
  specsMd: string,
  refs: (string | null | undefined)[],
  opts: SliceOptions = {},
): SliceResult {
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const includeOverview = opts.includeOverview ?? true;

  const resolved: string[] = [];
  const unresolved: string[] = [];
  const seen = new Set<string>(); // dedup key: heading|lineStart
  const picked: SpecSection[] = [];

  for (const raw of refs) {
    if (!raw || !raw.trim()) continue;
    const section = findSection(specsMd, raw);
    if (!section) {
      unresolved.push(raw);
      continue;
    }
    resolved.push(raw);
    const key = `${section.heading}|${section.lineStart}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push(section);
  }

  // Optionally prepend Overview if not already present.
  if (includeOverview) {
    const sections = parseSections(specsMd);
    const overview = sections.find(
      (s) => s.level === 2 && normalize(s.heading) === 'overview',
    );
    if (overview) {
      const key = `${overview.heading}|${overview.lineStart}`;
      if (!seen.has(key)) {
        seen.add(key);
        picked.unshift(overview);
      }
    }
  }

  if (picked.length === 0) {
    return { text: '', resolved, unresolved, bytes: 0 };
  }

  // Apply maxBytes by dropping trailing sections (no mid-section truncation).
  const separator = '\n\n---\n\n';
  const kept: SpecSection[] = [];
  let runningText = '';
  for (const s of picked) {
    const headerLine = `## Spec slice (${kept.length + 1} sections)\n\n`;
    const candidateBody = kept.length === 0 ? s.body : runningText + separator + s.body;
    const candidateText = headerLine + candidateBody;
    if (Buffer.byteLength(candidateText, 'utf8') > maxBytes && kept.length > 0) {
      break;
    }
    if (Buffer.byteLength(candidateText, 'utf8') > maxBytes && kept.length === 0) {
      // First section already exceeds the limit — keep it anyway, contract says
      // we drop trailing sections, not truncate mid-section.
      kept.push(s);
      runningText = candidateBody;
      break;
    }
    kept.push(s);
    runningText = candidateBody;
  }

  const header = `## Spec slice (${kept.length} sections)\n\n`;
  const text = header + runningText;
  return {
    text,
    resolved,
    unresolved,
    bytes: Buffer.byteLength(text, 'utf8'),
  };
}
