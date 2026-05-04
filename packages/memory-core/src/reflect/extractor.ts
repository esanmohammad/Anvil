/**
 * Parses the reflection JSON the LLM emits and shapes it into the
 * four-bucket structure the proposal-mapper consumes (Phase 11).
 *
 * Tolerant of:
 *   - Extra leading / trailing prose around the JSON block (greedy
 *     match on the outermost braces).
 *   - Missing buckets (default to []).
 *   - Per-item field omissions (skip the item; don't crash the run).
 */

export interface ReflectionFailure {
  what: string;
  rootCause: string;
  fix: string;
  filePath?: string;
}

export interface ReflectionSuccess {
  pattern: string;
  appliesWhen: string;
  codeSnippet?: string;
  filePath?: string;
}

export interface ReflectionSurprise {
  what: string;
  whySurprising: string;
}

export interface ReflectionSkillProposal {
  name: string;
  description: string;
  body: string;
}

export interface ReflectionResult {
  failures: ReflectionFailure[];
  successes: ReflectionSuccess[];
  surprises: ReflectionSurprise[];
  skillProposals: ReflectionSkillProposal[];
}

const EMPTY: ReflectionResult = {
  failures: [],
  successes: [],
  surprises: [],
  skillProposals: [],
};

export function parseReflectionJson(raw: string): ReflectionResult {
  const json = extractJsonBlock(raw);
  if (!json) return EMPTY;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return EMPTY;
  }
  if (!parsed || typeof parsed !== 'object') return EMPTY;
  const obj = parsed as Record<string, unknown>;

  return {
    failures: pickArray(obj.failures).flatMap(pickFailure),
    successes: pickArray(obj.successes).flatMap(pickSuccess),
    surprises: pickArray(obj.surprises).flatMap(pickSurprise),
    skillProposals: pickArray(obj.skill_proposals).flatMap(pickSkillProposal),
  };
}

function extractJsonBlock(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const first = trimmed.indexOf('{');
  const last = trimmed.lastIndexOf('}');
  if (first === -1 || last === -1 || last < first) return null;
  return trimmed.slice(first, last + 1);
}

function pickArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function pickFailure(v: unknown): ReflectionFailure[] {
  if (!v || typeof v !== 'object') return [];
  const o = v as Record<string, unknown>;
  const what = asString(o.what);
  const rootCause = asString(o.root_cause ?? o.rootCause);
  const fix = asString(o.fix);
  if (!what || !rootCause || !fix) return [];
  const filePath = asString(o.file_path ?? o.filePath) ?? undefined;
  return [{ what, rootCause, fix, filePath }];
}

function pickSuccess(v: unknown): ReflectionSuccess[] {
  if (!v || typeof v !== 'object') return [];
  const o = v as Record<string, unknown>;
  const pattern = asString(o.pattern);
  const appliesWhen = asString(o.applies_when ?? o.appliesWhen);
  if (!pattern || !appliesWhen) return [];
  const codeSnippet = asString(o.code_snippet ?? o.codeSnippet) ?? undefined;
  const filePath = asString(o.file_path ?? o.filePath) ?? undefined;
  return [{ pattern, appliesWhen, codeSnippet, filePath }];
}

function pickSurprise(v: unknown): ReflectionSurprise[] {
  if (!v || typeof v !== 'object') return [];
  const o = v as Record<string, unknown>;
  const what = asString(o.what);
  const whySurprising = asString(o.why_surprising ?? o.whySurprising);
  if (!what || !whySurprising) return [];
  return [{ what, whySurprising }];
}

function pickSkillProposal(v: unknown): ReflectionSkillProposal[] {
  if (!v || typeof v !== 'object') return [];
  const o = v as Record<string, unknown>;
  const name = asString(o.name);
  const description = asString(o.description);
  const body = asString(o.body);
  if (!name || !description || !body) return [];
  return [{ name, description, body }];
}
