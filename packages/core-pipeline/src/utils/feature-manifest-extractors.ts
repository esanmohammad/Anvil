/**
 * Phase 2 manifest extractors — deterministic regex parsers that pull
 * structured fields out of the markdown artifacts each stage produces.
 *
 * Phase F12 — promoted from
 * `packages/dashboard/server/feature-manifest-extractors.ts` into
 * `core-pipeline/utils`. Pure regex parsing — no fs / network /
 * process. Depends on F11's manifest type vocabulary, already in this
 * package.
 *
 * Why heuristic, not an LLM extraction call?
 *  • Personas already produce predictable headings (## Acceptance Criteria,
 *    ## API Endpoints, ## Files, etc.) and each stage's artifact is short
 *    enough that a regex sweep is reliable.
 *  • An extra LLM call per stage doubles latency and introduces flakiness
 *    (parse failures from non-strict JSON output) — net loss on a flow
 *    that exists to *save* tokens.
 *  • Returning `null` cleanly degrades to "field stays unset" — agents
 *    just re-derive when nothing was extractable. Safer than a hallucinated
 *    extraction.
 *
 * Each extractor returns `null` when it can't find anything confidently;
 * caller leaves the field untouched in that case.
 */

import type {
  ApiEndpoint,
  ManifestFieldKey,
  ManifestFieldValue,
  PlannedFile,
  TableMutation,
  TestBehavior,
} from './feature-manifest-types.js';

export interface ExtractorResult<K extends ManifestFieldKey = ManifestFieldKey> {
  field: K;
  status: 'partial' | 'final';
  value: ManifestFieldValue<K>;
}

export type ManifestExtractor = (artifact: string) => ExtractorResult | null;

// ── Section helpers ───────────────────────────────────────────────────────

/**
 * Pull the body of a markdown section by heading regex (case-insensitive).
 * Implemented as a line-walk because JS lacks `\Z`, so the obvious lookahead
 * approach with a built RegExp ends up matching a literal "Z".
 */
function findSection(artifact: string, headingPattern: RegExp): string | null {
  const lines = artifact.split(/\r?\n/);
  const headingRe = /^#{1,6}\s+(.*?)\s*$/;
  const body: string[] = [];
  let inSection = false;
  for (const line of lines) {
    const heading = line.match(headingRe);
    if (heading) {
      if (inSection) break;
      if (headingPattern.test(heading[1])) {
        inSection = true;
        continue;
      }
    }
    if (inSection) body.push(line);
  }
  if (!inSection) return null;
  return body.join('\n').trim();
}

/** Extract bullet-list items from a section body (-, *, or numeric). */
function bulletItems(body: string): string[] {
  const lines = body.split(/\r?\n/);
  const items: string[] = [];
  let current = '';
  const flush = (): void => {
    const trimmed = current.trim();
    if (trimmed) items.push(trimmed);
    current = '';
  };
  for (const raw of lines) {
    if (/^\s*(?:[-*•]|\d+[.)])\s+/.test(raw)) {
      flush();
      current = raw.replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '');
    } else if (/^\s+\S/.test(raw) && current) {
      current += ' ' + raw.trim();
    } else if (raw.trim() === '') {
      flush();
    }
  }
  flush();
  return items;
}

// ── Extractors ────────────────────────────────────────────────────────────

export const extractAcceptanceCriteria: ManifestExtractor = (artifact) => {
  const body =
    findSection(artifact, /(?:Acceptance\s+Criteria|Success\s+Criteria)/i) ??
    findSection(artifact, /Requirements/i);
  if (!body) return null;
  const items = bulletItems(body).filter((s) => s.length > 4);
  if (items.length === 0) return null;
  return { field: 'acceptanceCriteria', status: 'final', value: items };
};

export const extractAffectedRepos: ManifestExtractor = (artifact) => {
  const body =
    findSection(artifact, /(?:Affected\s+Repos?|Repositories?|Repos?\s+Touched)/i);
  if (!body) return null;
  const items = bulletItems(body)
    .map((s) => s.replace(/[`*_]/g, '').split(/\s|—|-—|:/)[0])
    .filter((s) => /^[\w./@-]+$/.test(s) && s.length > 1);
  const unique = Array.from(new Set(items));
  if (unique.length === 0) return null;
  return { field: 'affectedRepos', status: 'final', value: unique };
};

export const extractApiEndpoints: ManifestExtractor = (artifact) => {
  const body =
    findSection(artifact, /(?:API\s+Endpoints?|Endpoints?|Routes?)/i);
  if (!body) return null;
  // Match patterns like "GET /api/foo — purpose" or "POST /v1/bar: purpose".
  const re = /\b(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)(?:\s*[—–\-:]\s*(.+))?/gi;
  const out: ApiEndpoint[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(body)) !== null) {
    const purpose = (m[3] ?? '').trim();
    out.push({
      repo: '',
      method: m[1].toUpperCase(),
      path: m[2],
      purpose,
    });
  }
  if (out.length === 0) return null;
  return { field: 'apiEndpoints', status: 'partial', value: out };
};

export const extractTablesTouched: ManifestExtractor = (artifact) => {
  const body =
    findSection(artifact, /(?:Tables?\s+Touched|Database|Schema|Data\s+Model)/i);
  if (!body) return null;
  const out: TableMutation[] = [];
  for (const item of bulletItems(body)) {
    // Match "ALTER table foo", "ADD table bar", "READ from baz", etc.
    const m = item.match(/\b(add|alter|drop|create|modify|update|read|read-only)\b[^\w]+([`"']?)([\w.]+)\2/i);
    if (!m) continue;
    const verb = m[1].toLowerCase();
    const kind: TableMutation['mutationKind'] =
      verb === 'add' || verb === 'create' ? 'add' :
      verb === 'drop' ? 'drop' :
      verb === 'read' || verb === 'read-only' ? 'read-only' :
      'alter';
    out.push({ repo: '', table: m[3], mutationKind: kind });
  }
  if (out.length === 0) return null;
  return { field: 'tablesTouched', status: 'partial', value: out };
};

export const extractFilesPlanned: ManifestExtractor = (artifact) => {
  const body =
    findSection(artifact, /(?:Files|Files\s+Planned|Implementation\s+Tasks?|Tasks?)/i) ??
    artifact;
  const out: PlannedFile[] = [];
  // Match bullet lines starting with a path-like token.
  const lineRe = /^\s*(?:[-*•]|\d+[.)])\s+(?:create|modify|update|delete|add|remove)?\s*[`"']?([\w./@-]+\.\w{1,5})[`"']?/gim;
  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = lineRe.exec(body)) !== null) {
    const path = m[1];
    if (seen.has(path)) continue;
    seen.add(path);
    const verb = (body.slice(m.index, m.index + 80).match(/\b(create|delete|remove|add)\b/i)?.[1] ?? '').toLowerCase();
    const kind: PlannedFile['kind'] =
      verb === 'create' || verb === 'add' ? 'create' :
      verb === 'delete' || verb === 'remove' ? 'delete' :
      'modify';
    out.push({ repo: '', path, kind });
  }
  if (out.length === 0) return null;
  return { field: 'filesPlanned', status: 'partial', value: out };
};

export const extractTestBehaviors: ManifestExtractor = (artifact) => {
  const body =
    findSection(artifact, /(?:Test(?:s|ing)?(?:\s+Behaviors?)?|Acceptance\s+Tests?)/i);
  if (!body) return null;
  const items = bulletItems(body);
  const out: TestBehavior[] = [];
  for (const item of items) {
    if (item.length < 6) continue;
    const isGherkin = /\b(?:given|when|then)\b/i.test(item);
    out.push(isGherkin ? { description: item, gherkin: item } : { description: item });
  }
  if (out.length === 0) return null;
  return { field: 'testBehaviors', status: 'partial', value: out };
};

export const extractChangeBrief: ManifestExtractor = (artifact) => {
  // First try a "Summary" / "Change Brief" section.
  const body =
    findSection(artifact, /(?:Summary|Change\s+Brief|Overview)/i);
  if (body) {
    const firstLine = body.split(/\r?\n/).map((s) => s.trim()).find((s) => s.length > 0);
    if (firstLine) {
      return { field: 'changeBrief', status: 'final', value: firstLine.slice(0, 400) };
    }
  }
  // Fallback: first non-heading sentence.
  for (const raw of artifact.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.length < 12) continue;
    return { field: 'changeBrief', status: 'partial', value: line.slice(0, 400) };
  }
  return null;
};

export const extractOpenQuestions: ManifestExtractor = (artifact) => {
  const body =
    findSection(artifact, /(?:Open\s+Questions?|Unresolved|Notes?|Follow[\s-]ups?)/i);
  if (!body) return null;
  const items = bulletItems(body).filter((s) => s.length > 6);
  if (items.length === 0) return null;
  return { field: 'openQuestions', status: 'partial', value: items };
};
