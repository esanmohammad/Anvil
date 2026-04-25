/**
 * Loads and evaluates Anvil's declarative pipeline policy. Includes a tiny
 * zero-dep YAML subset parser and a small glob matcher — both intentionally
 * limited to what the policy schema needs.
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type {
  PipelinePolicy,
  PipelineStage,
  PolicyDecision,
  PolicyEvaluationInput,
} from './pipeline-policy-types.js';
import { POLICY_SCHEMA_VERSION } from './pipeline-policy-types.js';

// ── YAML node types ──────────────────────────────────────────────────────

export type YamlScalar = string | number | boolean | null;
export type YamlValue = YamlScalar | YamlValue[] | { [k: string]: YamlValue };

export class YamlParseError extends Error {
  line: number;
  constructor(opts: { line: number; message: string }) {
    super(`YAML parse error at line ${opts.line}: ${opts.message}`);
    this.line = opts.line;
    this.name = 'YamlParseError';
  }
}

// ── Tiny YAML parser ─────────────────────────────────────────────────────
// Subset: nested maps, string/number/bool/null scalars, flow arrays [a, b],
// block arrays (- item), # comments. Strict 2-space indentation.

interface Line { n: number; indent: number; text: string }

function preprocess(raw: string): Line[] {
  const out: Line[] = [];
  const src = raw.replace(/\r\n/g, '\n').split('\n');
  for (let i = 0; i < src.length; i++) {
    const row = src[i];
    // strip trailing comments (but keep '#' inside quoted strings)
    let stripped = '';
    let inSingle = false;
    let inDouble = false;
    for (let j = 0; j < row.length; j++) {
      const ch = row[j];
      if (ch === '"' && !inSingle) inDouble = !inDouble;
      else if (ch === "'" && !inDouble) inSingle = !inSingle;
      else if (ch === '#' && !inSingle && !inDouble) break;
      stripped += ch;
    }
    if (/^\s*$/.test(stripped)) continue;
    const m = stripped.match(/^( *)(.*\S)\s*$/);
    if (!m) continue;
    const indent = m[1].length;
    if (indent % 2 !== 0) {
      throw new YamlParseError({ line: i + 1, message: 'indent must be a multiple of 2 spaces' });
    }
    out.push({ n: i + 1, indent, text: m[2] });
  }
  return out;
}

function parseScalar(raw: string, lineNo: number): YamlScalar {
  const t = raw.trim();
  if (t === '') return '';
  if (t === 'null' || t === '~') return null;
  if (t === 'true') return true;
  if (t === 'false') return false;
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  if (/^-?\d+(\.\d+)?$/.test(t)) return Number(t);
  // bareword string
  return t;
}

function parseFlowArray(raw: string, lineNo: number): YamlValue[] {
  const inner = raw.slice(1, -1).trim();
  if (inner === '') return [];
  // naive split on commas outside quotes (good enough for scalars)
  const parts: string[] = [];
  let buf = '';
  let inSingle = false;
  let inDouble = false;
  for (const ch of inner) {
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "'" && !inDouble) inSingle = !inSingle;
    if (ch === ',' && !inSingle && !inDouble) {
      parts.push(buf);
      buf = '';
      continue;
    }
    buf += ch;
  }
  if (buf.trim() !== '') parts.push(buf);
  return parts.map((p) => parseScalar(p, lineNo));
}

function parseValue(raw: string, lineNo: number): YamlValue {
  const t = raw.trim();
  if (t.startsWith('[') && t.endsWith(']')) return parseFlowArray(t, lineNo);
  return parseScalar(t, lineNo);
}

interface ParseCtx { lines: Line[]; i: number }

function parseBlock(ctx: ParseCtx, indent: number): YamlValue {
  // Decide: mapping or sequence, based on first non-consumed line at this indent.
  if (ctx.i >= ctx.lines.length) return null;
  const first = ctx.lines[ctx.i];
  if (first.indent < indent) return null;

  if (first.text.startsWith('- ')) return parseSequence(ctx, indent);
  return parseMapping(ctx, indent);
}

function parseMapping(ctx: ParseCtx, indent: number): { [k: string]: YamlValue } {
  const out: { [k: string]: YamlValue } = {};
  while (ctx.i < ctx.lines.length) {
    const line = ctx.lines[ctx.i];
    if (line.indent < indent) break;
    if (line.indent !== indent) {
      throw new YamlParseError({ line: line.n, message: `unexpected indent ${line.indent}, expected ${indent}` });
    }
    if (line.text.startsWith('- ')) {
      throw new YamlParseError({ line: line.n, message: 'sequence item inside mapping' });
    }
    const colonIdx = findColon(line.text);
    if (colonIdx < 0) {
      throw new YamlParseError({ line: line.n, message: 'expected "key: value"' });
    }
    const key = line.text.slice(0, colonIdx).trim();
    const rest = line.text.slice(colonIdx + 1).trim();
    ctx.i++;

    if (rest === '') {
      // nested block starts on the next line at indent + 2
      const next = ctx.lines[ctx.i];
      if (!next || next.indent <= indent) {
        out[key] = null;
      } else if (next.indent !== indent + 2) {
        throw new YamlParseError({ line: next.n, message: `expected indent ${indent + 2}` });
      } else {
        out[key] = parseBlock(ctx, indent + 2);
      }
    } else {
      out[key] = parseValue(rest, line.n);
    }
  }
  return out;
}

function parseSequence(ctx: ParseCtx, indent: number): YamlValue[] {
  const out: YamlValue[] = [];
  while (ctx.i < ctx.lines.length) {
    const line = ctx.lines[ctx.i];
    if (line.indent < indent) break;
    if (line.indent !== indent) {
      throw new YamlParseError({ line: line.n, message: `unexpected indent ${line.indent}, expected ${indent}` });
    }
    if (!line.text.startsWith('- ')) break;
    const after = line.text.slice(2);
    const colonIdx = findColon(after);
    // Case A: "- scalar-or-flow-array"
    if (colonIdx < 0) {
      out.push(parseValue(after, line.n));
      ctx.i++;
      continue;
    }
    // Case B: "- key: value" — start of an inline mapping
    const inlineKey = after.slice(0, colonIdx).trim();
    const inlineRest = after.slice(colonIdx + 1).trim();
    const virtIndent = indent + 2;
    // Consume this line as the first key of a mapping; synthesize a mapping
    ctx.i++;
    const map: { [k: string]: YamlValue } = {};
    if (inlineRest === '') {
      const next = ctx.lines[ctx.i];
      if (next && next.indent === virtIndent + 2) {
        map[inlineKey] = parseBlock(ctx, virtIndent + 2);
      } else {
        map[inlineKey] = null;
      }
    } else {
      map[inlineKey] = parseValue(inlineRest, line.n);
    }
    // Remaining keys of this mapping live at virtIndent
    while (ctx.i < ctx.lines.length) {
      const peek = ctx.lines[ctx.i];
      if (peek.indent !== virtIndent) break;
      if (peek.text.startsWith('- ')) break;
      const cIdx = findColon(peek.text);
      if (cIdx < 0) {
        throw new YamlParseError({ line: peek.n, message: 'expected "key: value"' });
      }
      const k = peek.text.slice(0, cIdx).trim();
      const r = peek.text.slice(cIdx + 1).trim();
      ctx.i++;
      if (r === '') {
        const nextN = ctx.lines[ctx.i];
        if (nextN && nextN.indent === virtIndent + 2) {
          map[k] = parseBlock(ctx, virtIndent + 2);
        } else {
          map[k] = null;
        }
      } else {
        map[k] = parseValue(r, peek.n);
      }
    }
    out.push(map);
  }
  return out;
}

function findColon(text: string): number {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === ':' && !inSingle && !inDouble) return i;
  }
  return -1;
}

export function parseYaml(raw: string): YamlValue {
  const lines = preprocess(raw);
  if (lines.length === 0) return null;
  const ctx: ParseCtx = { lines, i: 0 };
  return parseBlock(ctx, 0);
}

// ── Type guards ──────────────────────────────────────────────────────────

function isObject(v: YamlValue): v is { [k: string]: YamlValue } {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function isArray(v: YamlValue): v is YamlValue[] { return Array.isArray(v); }
function isString(v: YamlValue): v is string { return typeof v === 'string'; }
function isNumber(v: YamlValue): v is number { return typeof v === 'number'; }

const VALID_STAGES: readonly PipelineStage[] = ['plan', 'implement', 'review', 'test', 'ship'];

function asStages(v: YamlValue): PipelineStage[] | undefined {
  if (!isArray(v)) return undefined;
  const out: PipelineStage[] = [];
  for (const item of v) {
    if (isString(item) && (VALID_STAGES as readonly string[]).includes(item)) {
      out.push(item as PipelineStage);
    }
  }
  return out;
}

function asStringArray(v: YamlValue): string[] | undefined {
  if (!isArray(v)) return undefined;
  return v.filter(isString);
}

// ── Shape YAML → PipelinePolicy ──────────────────────────────────────────

function shapePolicy(raw: YamlValue): PipelinePolicy {
  if (!isObject(raw)) {
    throw new Error('Policy root must be a mapping');
  }

  const version = isString(raw.version) ? raw.version : POLICY_SCHEMA_VERSION;

  const defaultsRaw = isObject(raw.defaults) ? raw.defaults : {};
  const defaults: PipelinePolicy['defaults'] = {};
  const pa = asStages(defaultsRaw.pauseAfter);
  if (pa) defaults.pauseAfter = pa;
  if (defaultsRaw.autoApproveIfRisk === 'low' || defaultsRaw.autoApproveIfRisk === 'med') {
    defaults.autoApproveIfRisk = defaultsRaw.autoApproveIfRisk;
  }
  if (isNumber(defaultsRaw.autoApproveIfConfidence)) {
    defaults.autoApproveIfConfidence = defaultsRaw.autoApproveIfConfidence;
  }

  const pathsRaw = isArray(raw.paths) ? raw.paths : [];
  const paths: PipelinePolicy['paths'] = [];
  for (const item of pathsRaw) {
    if (!isObject(item) || !isString(item.match)) continue;
    paths.push({
      match: item.match,
      pauseAfter: asStages(item.pauseAfter),
      autoApprove: typeof item.autoApprove === 'boolean' ? item.autoApprove : undefined,
      reviewers: asStringArray(item.reviewers),
    });
  }

  const policy: PipelinePolicy = { version, defaults, paths };

  if (isObject(raw.cost)) {
    const c = raw.cost;
    const cost: PipelinePolicy['cost'] = {};
    if (isObject(c.limits)) {
      const lim: NonNullable<PipelinePolicy['cost']>['limits'] = {};
      if (isNumber(c.limits.perRun)) lim.perRun = c.limits.perRun;
      if (isNumber(c.limits.perProjectDaily)) lim.perProjectDaily = c.limits.perProjectDaily;
      if (isObject(c.limits.perStage)) {
        const perStage: Partial<Record<PipelineStage, number>> = {};
        for (const st of VALID_STAGES) {
          const v = c.limits.perStage[st];
          if (isNumber(v)) perStage[st] = v;
        }
        lim.perStage = perStage;
      }
      cost.limits = lim;
    }
    if (isNumber(c.graceWindowSeconds)) cost.graceWindowSeconds = c.graceWindowSeconds;
    if (c.onBreach === 'ask' || c.onBreach === 'auto-approve' || c.onBreach === 'auto-reject') {
      cost.onBreach = c.onBreach;
    }
    if (isNumber(c.autoApproveBelow)) cost.autoApproveBelow = c.autoApproveBelow;
    policy.cost = cost;
  }

  if (isObject(raw.notifications)) {
    const n = raw.notifications;
    policy.notifications = {
      slack: typeof n.slack === 'boolean' ? n.slack : undefined,
      email: typeof n.email === 'boolean' ? n.email : undefined,
      timeoutHours: isNumber(n.timeoutHours) ? n.timeoutHours : undefined,
    };
  }

  if (isArray(raw.reviewers)) {
    const revs: NonNullable<PipelinePolicy['reviewers']> = [];
    for (const item of raw.reviewers) {
      if (!isObject(item) || !isString(item.match)) continue;
      const users = asStringArray(item.users) ?? [];
      revs.push({ match: item.match, users });
    }
    policy.reviewers = revs;
  }

  return policy;
}

// ── Glob matcher ─────────────────────────────────────────────────────────

/** Compile a tiny glob (** / * / ?) to a RegExp anchored against full path. */
export function globToRegExp(glob: string): RegExp {
  let re = '^';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      // ** = any number of path segments (including zero, with or without trailing slash)
      re += '.*';
      i++;
      // swallow an optional trailing slash so 'src/**/foo' matches 'src/foo'
      if (glob[i + 1] === '/') i++;
    } else if (c === '*') {
      re += '[^/]*';
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^$|(){}[]\\'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  re += '$';
  return new RegExp(re);
}

export function matchesGlob(glob: string, path: string): boolean {
  return globToRegExp(glob).test(path);
}

// ── Policy load + evaluate ───────────────────────────────────────────────

function defaultAnvilHome(): string {
  if (process.env.ANVIL_HOME) return process.env.ANVIL_HOME;
  return join(homedir(), '.anvil');
}

export function loadPolicy(projectSlug: string, anvilHome?: string): PipelinePolicy | null {
  const home = anvilHome ?? defaultAnvilHome();
  const path = join(home, 'projects', projectSlug, 'pipeline-policy.yaml');
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8');
  const node = parseYaml(raw);
  const policy = shapePolicy(node);

  // Layer dashboard-managed overlay (Settings → policy editor) on top of YAML.
  // Stored at `pipeline-policy.overlay.json` so the YAML's comments stay intact.
  const overlayPath = join(home, 'projects', projectSlug, 'pipeline-policy.overlay.json');
  if (existsSync(overlayPath)) {
    try {
      const overlay = JSON.parse(readFileSync(overlayPath, 'utf-8')) as { cost?: Record<string, unknown> };
      if (overlay.cost && typeof overlay.cost === 'object') {
        const cost = (policy.cost ??= {}) as NonNullable<PipelinePolicy['cost']>;
        const ov = overlay.cost as { onBreach?: 'ask' | 'auto-approve' | 'auto-reject'; autoApproveBelow?: number; graceWindowSeconds?: number; limits?: { perRun?: number; perProjectDaily?: number } };
        if (ov.onBreach) cost.onBreach = ov.onBreach;
        if (typeof ov.autoApproveBelow === 'number') cost.autoApproveBelow = ov.autoApproveBelow;
        if (typeof ov.graceWindowSeconds === 'number') cost.graceWindowSeconds = ov.graceWindowSeconds;
        if (ov.limits) {
          const lim = (cost.limits ??= {});
          if (typeof ov.limits.perRun === 'number') lim.perRun = ov.limits.perRun;
          if (typeof ov.limits.perProjectDaily === 'number') lim.perProjectDaily = ov.limits.perProjectDaily;
        }
      }
    } catch { /* malformed overlay — ignore, fall back to YAML */ }
  }

  return policy;
}

export function defaultPolicy(): PipelinePolicy {
  return {
    version: POLICY_SCHEMA_VERSION,
    defaults: { pauseAfter: ['plan'] },
    paths: [],
    cost: { onBreach: 'ask' },
  };
}

export function evaluatePolicy(policy: PipelinePolicy, input: PolicyEvaluationInput): PolicyDecision {
  const matchedRules: string[] = [];
  const reviewers = new Set<string>();

  // 1. Path rules — first matching rule with pauseAfter including stage wins.
  let pathPause = false;
  let pathMatchGlob: string | null = null;
  for (const rule of policy.paths) {
    const anyHit = input.touchedFiles.some((f) => matchesGlob(rule.match, f));
    if (!anyHit) continue;
    if (rule.reviewers) for (const u of rule.reviewers) reviewers.add(u);
    if (!pathPause && rule.pauseAfter?.includes(input.stage)) {
      pathPause = true;
      pathMatchGlob = rule.match;
    }
  }

  // Reviewers[] block — also contributes on path match.
  if (policy.reviewers) {
    for (const r of policy.reviewers) {
      if (input.touchedFiles.some((f) => matchesGlob(r.match, f))) {
        for (const u of r.users) reviewers.add(u);
      }
    }
  }

  if (pathPause && pathMatchGlob) {
    matchedRules.push(pathMatchGlob);
    return {
      pause: true,
      reason: `path-rule:${pathMatchGlob}`,
      matchedRules,
      reviewers: [...reviewers],
    };
  }

  // 2. Defaults
  const defaults = policy.defaults ?? {};
  if (defaults.pauseAfter?.includes(input.stage)) {
    matchedRules.push('defaults');
    // auto-approve by risk tier
    if (defaults.autoApproveIfRisk && input.riskTier) {
      const covers =
        (defaults.autoApproveIfRisk === 'low' && input.riskTier === 'low') ||
        (defaults.autoApproveIfRisk === 'med' && (input.riskTier === 'low' || input.riskTier === 'med'));
      if (covers) {
        return { pause: false, reason: 'auto-approve-risk', matchedRules, reviewers: [...reviewers] };
      }
    }
    // auto-approve by confidence
    if (
      typeof defaults.autoApproveIfConfidence === 'number' &&
      typeof input.confidence === 'number' &&
      input.confidence >= defaults.autoApproveIfConfidence
    ) {
      return { pause: false, reason: 'auto-approve-confidence', matchedRules, reviewers: [...reviewers] };
    }
    return { pause: true, reason: 'defaults-pause', matchedRules, reviewers: [...reviewers] };
  }

  // 3. No rule requires pause.
  return { pause: false, reason: 'no-rule', matchedRules, reviewers: [...reviewers] };
}

// ── Sample YAML for `policy init` ────────────────────────────────────────

export function samplePolicyYaml(): string {
  return `# Anvil pipeline policy — declarative rules for when the pipeline pauses,
# who reviews, and cost limits. See docs for the full schema.
version: ${POLICY_SCHEMA_VERSION}

defaults:
  # Stages after which Anvil should ask for confirmation by default.
  pauseAfter: [plan]
  # Skip the default pause when the change is low-risk.
  autoApproveIfRisk: low
  # Skip the default pause when agent confidence is at or above this threshold.
  autoApproveIfConfidence: 0.9

# Per-path overrides — the FIRST matching rule wins.
paths:
  - match: "**/auth/**"
    pauseAfter: [plan, implement, review]
    reviewers: [security-team]
  - match: "**/*.md"
    autoApprove: true
  - match: "src/migrations/**"
    pauseAfter: [plan, ship]
    reviewers: [db-owners]

cost:
  limits:
    perRun: 5.00
    perProjectDaily: 50.00
    perStage:
      implement: 2.50
      test: 1.00
  graceWindowSeconds: 30
  onBreach: ask
  autoApproveBelow: 0.25

notifications:
  slack: true
  email: false
  timeoutHours: 4

# Reviewers picked up in addition to any matching path rule.
reviewers:
  - match: "packages/billing/**"
    users: [billing-team, finance-leads]
`;
}
