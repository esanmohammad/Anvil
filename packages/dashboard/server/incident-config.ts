/**
 * incident-config — per-project configuration for Anvil's bug-to-test replay.
 *
 * The config lives at `~/.anvil/projects/<project>/incidents.yaml` (preferred,
 * human-editable) with a JSON fallback at `incidents.json`. We parse a tiny
 * YAML subset inline — just enough for the shapes this feature needs — to
 * avoid pulling in a new dependency. If YAML parsing fails we try JSON; if
 * both fail we return the default `{}`.
 *
 * Accepted YAML subset:
 *   - top-level `key: value` scalars (string, boolean, number)
 *   - nested mappings with 2-space indentation
 *   - `#` line comments
 *   - blank lines
 *
 * Not supported: flow-style (`{a: 1}`), lists (`- item`), multi-line scalars,
 * anchors, tags. These aren't needed for the schemas below.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import type { IncidentSeverity } from './incident-types.js';

// ── Types ────────────────────────────────────────────────────────────────

export interface SentryIntegrationConfig {
  org?: string;
  project?: string;
  authTokenEnv?: string;
}

export interface IncidentIoIntegrationConfig {
  workspace?: string;
  apiTokenEnv?: string;
}

export interface DatadogIntegrationConfig {
  site?: string;
  apiKeyEnv?: string;
  appKeyEnv?: string;
}

export interface IncidentsConfig {
  /** Whether incoming incidents should be auto-replayed. Default: false. */
  autoReplay?: boolean;
  /** Minimum severity that triggers auto-replay. Default: 'p3'. */
  minSeverity?: IncidentSeverity;
  sentry?: SentryIntegrationConfig;
  incidentio?: IncidentIoIntegrationConfig;
  datadog?: DatadogIntegrationConfig;
}

// ── Public API ───────────────────────────────────────────────────────────

export function readIncidentsConfig(anvilHome: string, project: string): IncidentsConfig {
  const dir = projectDir(anvilHome, project);
  const yamlPath = join(dir, 'incidents.yaml');
  const jsonPath = join(dir, 'incidents.json');

  if (existsSync(yamlPath)) {
    try {
      const raw = readFileSync(yamlPath, 'utf-8');
      return coerceConfig(parseTinyYaml(raw));
    } catch {
      /* fall through to JSON */
    }
  }
  if (existsSync(jsonPath)) {
    try {
      const raw = readFileSync(jsonPath, 'utf-8');
      return coerceConfig(JSON.parse(raw) as unknown);
    } catch {
      /* fall through to defaults */
    }
  }
  return {};
}

export function writeIncidentsConfig(
  anvilHome: string,
  project: string,
  config: IncidentsConfig,
): void {
  const dir = projectDir(anvilHome, project);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const yamlPath = join(dir, 'incidents.yaml');
  const yaml = emitYaml(config);
  atomicWrite(yamlPath, yaml);
}

// ── Defaults ─────────────────────────────────────────────────────────────

/**
 * Return a normalized config with the documented defaults applied.
 *
 * Defaults:
 *   - autoReplay:  false
 *   - minSeverity: 'p3'
 */
export function withDefaults(cfg: IncidentsConfig): Required<Pick<IncidentsConfig, 'autoReplay' | 'minSeverity'>> & IncidentsConfig {
  return {
    autoReplay: cfg.autoReplay ?? false,
    minSeverity: cfg.minSeverity ?? 'p3',
    ...cfg,
  };
}

// ── Internals ────────────────────────────────────────────────────────────

function projectDir(anvilHome: string, project: string): string {
  return join(anvilHome, 'projects', sanitizeProject(project));
}

function sanitizeProject(project: string): string {
  return project.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128) || 'default';
}

function atomicWrite(filePath: string, data: string): void {
  const parent = dirname(filePath);
  if (!existsSync(parent)) mkdirSync(parent, { recursive: true });
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, data, 'utf-8');
  renameSync(tmp, filePath);
}

// ── Tiny YAML parser ─────────────────────────────────────────────────────

type YamlNode = string | number | boolean | null | YamlMap;
interface YamlMap { [k: string]: YamlNode }

/**
 * Parses a minimal YAML subset. Throws on malformed indentation so that the
 * caller can fall back to JSON.
 */
export function parseTinyYaml(text: string): YamlMap {
  const root: YamlMap = {};
  // Stack of (indent, mapNode) — the top-of-stack map receives new keys whose
  // indent equals stack.top.indent + 2.
  const stack: { indent: number; node: YamlMap }[] = [{ indent: -2, node: root }];

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]!;
    // Strip trailing whitespace; preserve leading for indent detection.
    const line = rawLine.replace(/\s+$/, '');
    if (line === '') continue;

    // Comment-only line.
    const stripped = line.trimStart();
    if (stripped.startsWith('#')) continue;

    const indent = line.length - stripped.length;
    if (indent % 2 !== 0) {
      throw new Error(`parseTinyYaml: non-even indent on line ${i + 1}`);
    }

    // Pop any parent scopes that are now deeper/equal to this line's indent.
    while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) {
      stack.pop();
    }
    const parentFrame = stack[stack.length - 1]!;
    if (indent !== parentFrame.indent + 2) {
      throw new Error(`parseTinyYaml: bad indent (${indent}) on line ${i + 1}`);
    }

    // Parse `key:` or `key: value` (strip trailing inline `#` comment).
    const commentStripped = stripInlineComment(stripped);
    const m = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:(?:\s+(.*))?$/.exec(commentStripped);
    if (!m) {
      throw new Error(`parseTinyYaml: unparseable line ${i + 1}: "${stripped}"`);
    }
    const key = m[1]!;
    const valStr = (m[2] ?? '').trim();

    if (valStr === '') {
      // Nested mapping.
      const child: YamlMap = {};
      parentFrame.node[key] = child;
      stack.push({ indent, node: child });
    } else {
      parentFrame.node[key] = parseScalar(valStr);
    }
  }
  return root;
}

function stripInlineComment(line: string): string {
  // Only strip `#` that is preceded by whitespace, so `"https://x#y"` keeps
  // its fragment. Respect quoted strings.
  let inQuote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuote) {
      if (ch === inQuote) inQuote = null;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inQuote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]!))) {
      return line.slice(0, i).replace(/\s+$/, '');
    }
  }
  return line;
}

function parseScalar(raw: string): YamlNode {
  // Quoted strings — preserve as-is (modulo the surrounding quotes).
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    return raw.slice(1, -1);
  }
  // Booleans.
  const lower = raw.toLowerCase();
  if (lower === 'true' || lower === 'yes' || lower === 'on') return true;
  if (lower === 'false' || lower === 'no' || lower === 'off') return false;
  // Null.
  if (lower === 'null' || lower === '~' || lower === '') return null;
  // Number.
  if (/^-?\d+$/.test(raw)) {
    const n = Number.parseInt(raw, 10);
    if (Number.isFinite(n)) return n;
  }
  if (/^-?\d+\.\d+$/.test(raw)) {
    const n = Number.parseFloat(raw);
    if (Number.isFinite(n)) return n;
  }
  // Bare string.
  return raw;
}

// ── Coercion: YAML/JSON unknown → IncidentsConfig ────────────────────────

function coerceConfig(raw: unknown): IncidentsConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const r = raw as Record<string, unknown>;
  const out: IncidentsConfig = {};
  if (typeof r.autoReplay === 'boolean') out.autoReplay = r.autoReplay;
  if (isSeverity(r.minSeverity)) out.minSeverity = r.minSeverity;
  const sentry = coerceSentry(r.sentry);
  if (sentry) out.sentry = sentry;
  const incidentio = coerceIncidentIo(r.incidentio);
  if (incidentio) out.incidentio = incidentio;
  const datadog = coerceDatadog(r.datadog);
  if (datadog) out.datadog = datadog;
  return out;
}

function coerceSentry(v: unknown): SentryIntegrationConfig | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  const out: SentryIntegrationConfig = {};
  if (typeof r.org === 'string') out.org = r.org;
  if (typeof r.project === 'string') out.project = r.project;
  if (typeof r.authTokenEnv === 'string') out.authTokenEnv = r.authTokenEnv;
  return Object.keys(out).length > 0 ? out : undefined;
}

function coerceIncidentIo(v: unknown): IncidentIoIntegrationConfig | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  const out: IncidentIoIntegrationConfig = {};
  if (typeof r.workspace === 'string') out.workspace = r.workspace;
  if (typeof r.apiTokenEnv === 'string') out.apiTokenEnv = r.apiTokenEnv;
  return Object.keys(out).length > 0 ? out : undefined;
}

function coerceDatadog(v: unknown): DatadogIntegrationConfig | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const r = v as Record<string, unknown>;
  const out: DatadogIntegrationConfig = {};
  if (typeof r.site === 'string') out.site = r.site;
  if (typeof r.apiKeyEnv === 'string') out.apiKeyEnv = r.apiKeyEnv;
  if (typeof r.appKeyEnv === 'string') out.appKeyEnv = r.appKeyEnv;
  return Object.keys(out).length > 0 ? out : undefined;
}

function isSeverity(v: unknown): v is IncidentSeverity {
  return v === 'p1' || v === 'p2' || v === 'p3' || v === 'p4' || v === 'unknown';
}

// ── YAML emitter ─────────────────────────────────────────────────────────

/**
 * Emits a config as the same small YAML dialect the parser accepts. Only
 * known keys are emitted; undefined values are skipped.
 */
export function emitYaml(cfg: IncidentsConfig): string {
  const lines: string[] = [];
  if (cfg.autoReplay !== undefined) lines.push(`autoReplay: ${cfg.autoReplay}`);
  if (cfg.minSeverity !== undefined) lines.push(`minSeverity: ${cfg.minSeverity}`);
  if (cfg.sentry) {
    const block = emitBlock('sentry', cfg.sentry as Record<string, unknown>);
    if (block) lines.push(block);
  }
  if (cfg.incidentio) {
    const block = emitBlock('incidentio', cfg.incidentio as Record<string, unknown>);
    if (block) lines.push(block);
  }
  if (cfg.datadog) {
    const block = emitBlock('datadog', cfg.datadog as Record<string, unknown>);
    if (block) lines.push(block);
  }
  if (lines.length === 0) return '';
  return lines.join('\n') + '\n';
}

function emitBlock(key: string, obj: Record<string, unknown>): string | null {
  const inner: string[] = [];
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    inner.push(`  ${k}: ${emitScalar(v)}`);
  }
  if (inner.length === 0) return null;
  return `${key}:\n${inner.join('\n')}`;
}

function emitScalar(v: unknown): string {
  if (typeof v === 'string') {
    // Quote if the string contains a character that would confuse the parser.
    if (/[:#]/.test(v) || /^\s/.test(v) || /\s$/.test(v) || v === '') {
      return `"${v.replace(/"/g, '\\"')}"`;
    }
    // Also quote reserved words so they're not coerced to bool/null on re-read.
    const lower = v.toLowerCase();
    if (
      lower === 'true' ||
      lower === 'false' ||
      lower === 'yes' ||
      lower === 'no' ||
      lower === 'on' ||
      lower === 'off' ||
      lower === 'null' ||
      lower === '~'
    ) {
      return `"${v}"`;
    }
    return v;
  }
  if (typeof v === 'boolean' || typeof v === 'number') return String(v);
  if (v === null) return 'null';
  // Fall back to JSON for anything else.
  return JSON.stringify(v);
}
