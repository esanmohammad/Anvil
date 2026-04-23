/**
 * contract-test-gen — discovers contract sources (OpenAPI, tRPC, GraphQL)
 * in a repo and emits `kind: 'contract'` Behaviors for each
 * endpoint / procedure / field.
 *
 * Phase 3 of Anvil's test-generation pipeline. No new npm deps — everything
 * is parsed with JSON.parse, a minimal YAML subset parser, and regex.
 *
 * Safety: never throws on malformed input. Logs to stderr and degrades to
 * a lower-confidence Behavior or skips the source entirely.
 */

import {
  readdirSync,
  readFileSync,
  statSync,
  type Dirent,
} from 'node:fs';
import { basename, extname, join, posix, resolve } from 'node:path';

import type { Behavior, Priority } from './test-types.js';

// ── Public types ────────────────────────────────────────────────────────

export type ContractSource = 'openapi' | 'trpc' | 'graphql';

export interface ContractDiscoveryResult {
  sources: Array<{
    kind: ContractSource;
    filePath: string;
    summary: string;
  }>;
}

export interface DiscoverOptions {
  repoLocalPath: string;
  /** Max files to scan per source kind, default 10. */
  maxFilesPerSource?: number;
}

export interface GenerateOptions {
  repoLocalPath: string;
  /** Subset — if omitted, use everything discovered. */
  sources?: ContractDiscoveryResult['sources'];
  /** Cap behaviors per source. Default 30. */
  maxBehaviorsPerSource?: number;
}

export interface GenerateResult {
  behaviors: Behavior[];
  bySource: Record<string, number>;
}

// ── Constants ───────────────────────────────────────────────────────────

const MAX_DEPTH = 4;
const MAX_ENTRIES = 5000;
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  '.git',
  '.next',
  'coverage',
  '.cache',
  '.turbo',
  '.output',
]);

const OPENAPI_NAME_RE = /^(?:openapi|swagger)\.(?:json|ya?ml)$|\.openapi\.(?:json|ya?ml)$/i;
const OPENAPI_CONTENT_RE = /^[\s{]*["']?(openapi|swagger)["']?\s*:/m;

const TRPC_PATH_RE = /(?:^|[\\/])(?:server[\\/]routers|trpc|routers)[\\/]/i;
const TRPC_CONTENT_RE =
  /(?:router\s*\(\s*\{|createTRPCRouter\s*\()[\s\S]*?(publicProcedure|protectedProcedure)/;

const GRAPHQL_CONTENT_RE =
  /(?:gql|graphql)\s*`[\s\S]*?type\s+(?:Query|Mutation|Subscription)\b[\s\S]*?`/;

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head', 'trace'] as const;

// ── Safe filesystem helpers ─────────────────────────────────────────────

interface WalkLimit {
  visited: number;
}

function safeReadDir(dir: string): Dirent[] {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function safeRead(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function safeStat(path: string): ReturnType<typeof statSync> | null {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

function warn(msg: string): void {
  try {
    process.stderr.write(`[contract-test-gen] ${msg}\n`);
  } catch {
    /* noop */
  }
}

// ── Walker ──────────────────────────────────────────────────────────────

/** Iteratively walk `root` up to `MAX_DEPTH`, yielding file paths. */
function* walkRepo(root: string, limit: WalkLimit): Generator<string> {
  const stat = safeStat(root);
  if (!stat || !stat.isDirectory()) return;

  const stack: Array<{ dir: string; depth: number }> = [{ dir: root, depth: 0 }];

  while (stack.length) {
    if (limit.visited >= MAX_ENTRIES) return;
    const frame = stack.pop();
    if (!frame) break;
    const { dir, depth } = frame;
    const entries = safeReadDir(dir);
    for (const ent of entries) {
      if (limit.visited >= MAX_ENTRIES) return;
      limit.visited++;
      const name = ent.name;
      if (name.startsWith('.') && name !== '.' && name !== '..' && SKIP_DIRS.has(name)) continue;
      if (SKIP_DIRS.has(name)) continue;
      const full = join(dir, name);
      if (ent.isDirectory()) {
        if (depth + 1 <= MAX_DEPTH) stack.push({ dir: full, depth: depth + 1 });
      } else if (ent.isFile()) {
        yield full;
      }
    }
  }
}

// ── OpenAPI detection & parsing ─────────────────────────────────────────

function looksLikeOpenApi(path: string, content: string | null): boolean {
  const base = basename(path);
  if (OPENAPI_NAME_RE.test(base)) return true;
  if (!content) return false;
  const ext = extname(base).toLowerCase();
  if (!['.json', '.yaml', '.yml'].includes(ext)) return false;
  return OPENAPI_CONTENT_RE.test(content.slice(0, 4096));
}

/**
 * Parse a minimal YAML subset — good enough for OpenAPI:
 *   - nested mappings via 2-space indent
 *   - sequences via `- ` items
 *   - scalars (string, number, bool, null)
 *   - no anchors / aliases / multiline folded blocks / tags
 * Returns `null` on structural failure.
 */
function parseMinimalYaml(text: string): unknown {
  // Strip comments & trailing whitespace; keep blank lines for structure.
  const rawLines = text.split(/\r?\n/);
  type Line = { indent: number; content: string; lineNo: number };
  const lines: Line[] = [];
  for (let i = 0; i < rawLines.length; i++) {
    const l = rawLines[i] ?? '';
    // Strip comments that aren't inside quotes.
    const noComment = stripYamlComment(l);
    if (!noComment.trim()) continue;
    const m = /^(\s*)(.*)$/.exec(noComment);
    if (!m) continue;
    lines.push({ indent: m[1]!.length, content: m[2]!.trimEnd(), lineNo: i + 1 });
  }

  let cursor = 0;

  function peek(): Line | undefined {
    return lines[cursor];
  }

  function parseBlock(baseIndent: number): unknown {
    const first = peek();
    if (!first || first.indent < baseIndent) return null;

    // Sequence?
    if (first.content.startsWith('- ') || first.content === '-') {
      const arr: unknown[] = [];
      while (cursor < lines.length) {
        const line = lines[cursor]!;
        if (line.indent < baseIndent) break;
        if (line.indent > baseIndent) break;
        if (!line.content.startsWith('-')) break;
        const rest = line.content === '-' ? '' : line.content.slice(2);
        cursor++;
        if (!rest) {
          // nested block under this item
          const nested = parseBlock(baseIndent + 2);
          arr.push(nested);
        } else if (rest.includes(':') && !/^['"]/.test(rest)) {
          // Inline mapping entry as first key of a map item.
          const mapStart = cursor - 1;
          // Treat the "- key: val" as a mapping item. Reinject content without the dash.
          lines[mapStart] = {
            ...lines[mapStart]!,
            indent: baseIndent + 2,
            content: rest,
          };
          cursor = mapStart;
          const obj = parseMapping(baseIndent + 2);
          arr.push(obj);
        } else {
          arr.push(parseScalar(rest));
        }
      }
      return arr;
    }

    // Mapping.
    return parseMapping(baseIndent);
  }

  function parseMapping(indent: number): Record<string, unknown> {
    const obj: Record<string, unknown> = {};
    while (cursor < lines.length) {
      const line = lines[cursor]!;
      if (line.indent < indent) break;
      if (line.indent > indent) break;
      // key: value | key:
      const kv = splitKeyValue(line.content);
      if (!kv) {
        // Non-mapping line at this indent ends the mapping.
        break;
      }
      const [key, rawVal] = kv;
      cursor++;
      if (rawVal === '') {
        // Nested block.
        const next = peek();
        if (next && next.indent > indent) {
          obj[key] = parseBlock(next.indent);
        } else {
          obj[key] = null;
        }
      } else {
        obj[key] = parseScalar(rawVal);
      }
    }
    return obj;
  }

  try {
    const out = parseBlock(0);
    return out;
  } catch (e) {
    return null;
  }
}

function stripYamlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"' && !inSingle) inDouble = !inDouble;
    else if (c === "'" && !inDouble) inSingle = !inSingle;
    else if (c === '#' && !inSingle && !inDouble) {
      return line.slice(0, i);
    }
  }
  return line;
}

function splitKeyValue(content: string): [string, string] | null {
  // Key: value — key can be quoted.
  let i = 0;
  let key = '';
  if (content.startsWith('"') || content.startsWith("'")) {
    const quote = content[0]!;
    const end = content.indexOf(quote, 1);
    if (end === -1) return null;
    key = content.slice(1, end);
    i = end + 1;
  } else {
    const colon = content.indexOf(':');
    if (colon === -1) return null;
    key = content.slice(0, colon).trim();
    i = colon;
  }
  // Skip optional whitespace then ':'
  while (i < content.length && /\s/.test(content[i]!)) i++;
  if (content[i] !== ':') {
    // Maybe key already captured through quote path; find ':'
    const rest = content.slice(i);
    if (!rest.startsWith(':')) return null;
  }
  // Find ':' position past key
  const colonIdx = content.indexOf(':', i);
  if (colonIdx === -1) return null;
  const value = content.slice(colonIdx + 1).trim();
  if (!key) return null;
  return [key, value];
}

function parseScalar(raw: string): unknown {
  const v = raw.trim();
  if (v === '' || v === '~' || v === 'null' || v === 'Null' || v === 'NULL') return null;
  if (v === 'true' || v === 'True' || v === 'TRUE') return true;
  if (v === 'false' || v === 'False' || v === 'FALSE') return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d+\.\d+$/.test(v)) return Number(v);
  // Quoted strings
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  // Inline flow sequence [a, b]
  if (v.startsWith('[') && v.endsWith(']')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(',').map((s) => parseScalar(s));
  }
  // Inline flow mapping {a: b}
  if (v.startsWith('{') && v.endsWith('}')) {
    const inner = v.slice(1, -1).trim();
    if (!inner) return {};
    const obj: Record<string, unknown> = {};
    for (const pair of inner.split(',')) {
      const idx = pair.indexOf(':');
      if (idx === -1) continue;
      obj[pair.slice(0, idx).trim()] = parseScalar(pair.slice(idx + 1));
    }
    return obj;
  }
  return v;
}

interface OpenApiOperation {
  path: string;
  method: string;
  summary?: string;
  description?: string;
  parameters: Array<{ name: string; in?: string; required?: boolean; type?: string }>;
  responses: Array<{ status: string; description?: string; contentTypes: string[] }>;
  hasSecurity: boolean;
}

interface OpenApiParsed {
  version: string;
  operations: OpenApiOperation[];
}

function parseOpenApi(filePath: string, content: string): OpenApiParsed | null {
  const ext = extname(filePath).toLowerCase();
  let doc: unknown = null;

  if (ext === '.json') {
    try {
      doc = JSON.parse(content);
    } catch {
      warn(`OpenAPI JSON parse failed: ${filePath}`);
      return null;
    }
  } else {
    // Try JSON first (some .yaml files are actually JSON).
    try {
      doc = JSON.parse(content);
    } catch {
      doc = parseMinimalYaml(content);
    }
  }

  if (!doc || typeof doc !== 'object') return null;
  const root = doc as Record<string, unknown>;
  const version =
    (typeof root.openapi === 'string' && root.openapi) ||
    (typeof root.swagger === 'string' && `Swagger ${root.swagger}`) ||
    'unknown';

  const paths = root.paths;
  if (!paths || typeof paths !== 'object') return { version: String(version), operations: [] };

  const hasGlobalSecurity =
    Array.isArray((root as Record<string, unknown>).security) &&
    ((root as { security?: unknown[] }).security as unknown[]).length > 0;

  const operations: OpenApiOperation[] = [];
  for (const [pathKey, pathItem] of Object.entries(paths as Record<string, unknown>)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const item = pathItem as Record<string, unknown>;
    for (const method of HTTP_METHODS) {
      const op = item[method];
      if (!op || typeof op !== 'object') continue;
      const opObj = op as Record<string, unknown>;

      const parameters: OpenApiOperation['parameters'] = [];
      const paramList = Array.isArray(opObj.parameters)
        ? opObj.parameters
        : Array.isArray(item.parameters)
          ? item.parameters
          : [];
      for (const p of paramList) {
        if (!p || typeof p !== 'object') continue;
        const pp = p as Record<string, unknown>;
        const schema = pp.schema && typeof pp.schema === 'object' ? (pp.schema as Record<string, unknown>) : undefined;
        parameters.push({
          name: typeof pp.name === 'string' ? pp.name : '(unnamed)',
          in: typeof pp.in === 'string' ? pp.in : undefined,
          required: pp.required === true,
          type: (typeof pp.type === 'string' ? pp.type : undefined) ??
            (schema && typeof schema.type === 'string' ? schema.type : undefined),
        });
      }

      const responses: OpenApiOperation['responses'] = [];
      const respMap =
        opObj.responses && typeof opObj.responses === 'object'
          ? (opObj.responses as Record<string, unknown>)
          : {};
      for (const [status, resp] of Object.entries(respMap)) {
        if (!resp || typeof resp !== 'object') continue;
        const r = resp as Record<string, unknown>;
        const contentTypes: string[] = [];
        if (r.content && typeof r.content === 'object') {
          for (const ct of Object.keys(r.content as Record<string, unknown>)) {
            contentTypes.push(ct);
          }
        }
        responses.push({
          status,
          description: typeof r.description === 'string' ? r.description : undefined,
          contentTypes,
        });
      }

      const opSec = Array.isArray(opObj.security) ? (opObj.security as unknown[]) : null;
      const hasSecurity =
        (opSec !== null ? opSec.length > 0 : hasGlobalSecurity) === true;

      operations.push({
        path: pathKey,
        method: method.toUpperCase(),
        summary: typeof opObj.summary === 'string' ? opObj.summary : undefined,
        description: typeof opObj.description === 'string' ? opObj.description : undefined,
        parameters,
        responses,
        hasSecurity,
      });
    }
  }

  return { version: String(version), operations };
}

/** Regex fallback when YAML parse failed — produce low-fidelity operations. */
function parseOpenApiRegexFallback(content: string): OpenApiOperation[] {
  const lines = content.split(/\r?\n/);
  const ops: OpenApiOperation[] = [];
  let inPaths = false;
  let currentPath = '';
  let pathIndent = -1;

  for (const raw of lines) {
    const line = stripYamlComment(raw).replace(/\s+$/, '');
    if (!line.trim()) continue;
    const indentMatch = /^(\s*)/.exec(line);
    const indent = indentMatch ? indentMatch[1]!.length : 0;

    if (!inPaths) {
      if (/^paths\s*:/.test(line)) {
        inPaths = true;
        pathIndent = indent;
      }
      continue;
    }

    if (indent <= pathIndent && !line.trim().startsWith('#')) {
      // left the paths block
      inPaths = false;
      continue;
    }

    // Path entry: /foo/bar:
    const pathMatch = /^(\s+)(\/[^\s:]*)\s*:/.exec(line);
    if (pathMatch && pathMatch[1]!.length === pathIndent + 2) {
      currentPath = pathMatch[2]!;
      continue;
    }

    const methodMatch = /^(\s+)(get|post|put|patch|delete|options|head|trace)\s*:/i.exec(line);
    if (methodMatch && currentPath) {
      ops.push({
        path: currentPath,
        method: methodMatch[2]!.toUpperCase(),
        parameters: [],
        responses: [],
        hasSecurity: false,
      });
    }
  }
  return ops;
}

// ── OpenAPI handler resolution ──────────────────────────────────────────

/** Search the repo (bounded) for a handler file referencing the route path. */
function findOpenApiHandler(
  repoRoot: string,
  apiPath: string,
  limit: WalkLimit,
): { file: string; symbol?: string } | null {
  if (!apiPath) return null;
  // Escape regex special chars in the path, but preserve `{param}` style.
  const escaped = apiPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const patterns = [
    new RegExp(`\\.route\\s*\\(\\s*['"\`]${escaped}['"\`]`),
    new RegExp(`@(Get|Post|Put|Patch|Delete)\\s*\\(\\s*['"\`]${escaped}['"\`]`),
    new RegExp(`\\.(get|post|put|patch|delete)\\s*\\(\\s*['"\`]${escaped}['"\`]`),
  ];
  let localLimit = 0;
  for (const file of walkRepo(repoRoot, limit)) {
    if (localLimit++ > 500) break;
    const ext = extname(file).toLowerCase();
    if (!['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs'].includes(ext)) continue;
    const content = safeRead(file);
    if (!content) continue;
    for (const re of patterns) {
      const m = re.exec(content);
      if (m) {
        // Try to recover a handler symbol on the same line.
        const before = content.slice(0, m.index);
        const nl = before.lastIndexOf('\n');
        const lineStart = nl === -1 ? 0 : nl + 1;
        const fullLine = content.slice(lineStart, content.indexOf('\n', m.index + 1) >>> 0);
        const symMatch = /,\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/.exec(fullLine);
        return { file, symbol: symMatch ? symMatch[1] : undefined };
      }
    }
  }
  return null;
}

// ── tRPC parsing ────────────────────────────────────────────────────────

interface TrpcProcedure {
  name: string;
  kind: 'query' | 'mutation' | 'subscription';
  isProtected: boolean;
  inputShape?: string;
}

function parseTrpc(content: string): TrpcProcedure[] {
  const out: TrpcProcedure[] = [];
  // Match `name: (public|protected)Procedure...( .query( | .mutation( | .subscription( )
  const procRe =
    /(\b[A-Za-z_][A-Za-z0-9_]*)\s*:\s*(publicProcedure|protectedProcedure)([\s\S]*?)\.(query|mutation|subscription)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = procRe.exec(content)) !== null) {
    const name = m[1]!;
    const proc = m[2]!;
    const chain = m[3] ?? '';
    const kind = m[4] as TrpcProcedure['kind'];
    out.push({
      name,
      kind,
      isProtected: proc === 'protectedProcedure',
      inputShape: extractZodShape(chain),
    });
    if (out.length > 200) break;
  }
  return out;
}

/** Best-effort extract of `.input(z.object({ ... }))` — returns `"a:string, b:number"`. */
function extractZodShape(chain: string): string | undefined {
  const inputRe = /\.input\s*\(\s*z\.object\s*\(\s*\{([\s\S]*?)\}\s*\)\s*\)/;
  const m = inputRe.exec(chain);
  if (!m) return undefined;
  const body = m[1]!;
  const fieldRe = /(\b[A-Za-z_][A-Za-z0-9_]*)\s*:\s*z\.(\w+)/g;
  const parts: string[] = [];
  let f: RegExpExecArray | null;
  while ((f = fieldRe.exec(body)) !== null) {
    parts.push(`${f[1]}:${f[2]}`);
    if (parts.length > 20) break;
  }
  return parts.length ? parts.join(', ') : undefined;
}

function countTrpcProcedures(content: string): number {
  const re = /\b(publicProcedure|protectedProcedure)[\s\S]*?\.(query|mutation|subscription)\s*\(/g;
  let n = 0;
  while (re.exec(content) !== null) n++;
  return n;
}

// ── GraphQL parsing ─────────────────────────────────────────────────────

interface GraphqlField {
  root: 'Query' | 'Mutation' | 'Subscription';
  name: string;
  args: string[];
  returnType: string;
}

/** Extract SDL body — either the whole file (for .graphql/.gql) or the gql`...` template content. */
function extractSdlBodies(filePath: string, content: string): string[] {
  const ext = extname(filePath).toLowerCase();
  if (ext === '.graphql' || ext === '.gql') return [content];
  const out: string[] = [];
  const re = /(?:gql|graphql)\s*`([\s\S]*?)`/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) out.push(m[1]!);
  return out;
}

function parseGraphqlSdl(sdl: string): GraphqlField[] {
  const fields: GraphqlField[] = [];
  // Normalize, strip block comments "# ..."
  const cleaned = sdl
    .split(/\r?\n/)
    .map((l) => {
      // Only strip `#` comments outside of quotes — quick heuristic.
      const idx = l.indexOf('#');
      if (idx === -1) return l;
      return l.slice(0, idx);
    })
    .join('\n');

  const typeRe = /\btype\s+(Query|Mutation|Subscription)\b[^{]*\{/g;
  let m: RegExpExecArray | null;
  while ((m = typeRe.exec(cleaned)) !== null) {
    const root = m[1] as GraphqlField['root'];
    const bodyStart = typeRe.lastIndex;
    const body = readBracedBlock(cleaned, bodyStart - 1);
    if (!body) continue;
    const fieldLines = body.split(/\r?\n/);
    for (const rawLine of fieldLines) {
      const line = rawLine.trim();
      if (!line) continue;
      // fieldName(arg1: Type!, arg2: [Type]): ReturnType
      // OR fieldName: ReturnType
      const fieldMatch = /^([A-Za-z_][A-Za-z0-9_]*)\s*(\([^)]*\))?\s*:\s*([^\s,]+(?:\s*!)?)/.exec(line);
      if (!fieldMatch) continue;
      const name = fieldMatch[1]!;
      const argsRaw = fieldMatch[2] ?? '';
      const returnType = fieldMatch[3]!.replace(/,$/, '');
      const args = argsRaw
        ? argsRaw
            .slice(1, -1)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      fields.push({ root, name, args, returnType });
      if (fields.length > 500) return fields;
    }
  }
  return fields;
}

/** Given a source and an index at `{`, return the contents up to the matching `}`. */
function readBracedBlock(src: string, openIdx: number): string | null {
  if (src[openIdx] !== '{') {
    // Move forward to find it.
    while (openIdx < src.length && src[openIdx] !== '{') openIdx++;
    if (src[openIdx] !== '{') return null;
  }
  let depth = 0;
  let i = openIdx;
  for (; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(openIdx + 1, i);
    }
  }
  return null;
}

// ── Discovery ───────────────────────────────────────────────────────────

export async function discoverContractSources(
  opts: DiscoverOptions,
): Promise<ContractDiscoveryResult> {
  const { repoLocalPath } = opts;
  const cap = opts.maxFilesPerSource ?? 10;
  const root = resolve(repoLocalPath);

  const out: ContractDiscoveryResult['sources'] = [];
  const seen = new Set<string>();
  const counts: Record<ContractSource, number> = { openapi: 0, trpc: 0, graphql: 0 };

  const rootStat = safeStat(root);
  if (!rootStat || !rootStat.isDirectory()) {
    warn(`repoLocalPath is not a directory: ${root}`);
    return { sources: [] };
  }

  const limit: WalkLimit = { visited: 0 };

  for (const file of walkRepo(root, limit)) {
    if (
      counts.openapi >= cap &&
      counts.trpc >= cap &&
      counts.graphql >= cap
    ) {
      break;
    }
    const ext = extname(file).toLowerCase();
    const base = basename(file);

    // GraphQL SDL file
    if (ext === '.graphql' || ext === '.gql') {
      if (counts.graphql >= cap) continue;
      const content = safeRead(file);
      if (!content) continue;
      const fields = parseGraphqlSdl(content);
      if (!fields.length) continue;
      if (seen.has(file)) continue;
      seen.add(file);
      out.push({
        kind: 'graphql',
        filePath: file,
        summary: summarizeGraphql(fields),
      });
      counts.graphql++;
      continue;
    }

    // OpenAPI by name
    if (OPENAPI_NAME_RE.test(base)) {
      if (counts.openapi >= cap) continue;
      const content = safeRead(file);
      if (!content) continue;
      const parsed = parseOpenApi(file, content);
      if (!parsed) continue;
      if (seen.has(file)) continue;
      seen.add(file);
      out.push({
        kind: 'openapi',
        filePath: file,
        summary: `OpenAPI ${parsed.version} (${parsed.operations.length} operations)`,
      });
      counts.openapi++;
      continue;
    }

    // Other potential OpenAPI (JSON/YAML with openapi/swagger key)
    if (['.json', '.yaml', '.yml'].includes(ext) && counts.openapi < cap) {
      const content = safeRead(file);
      if (content && looksLikeOpenApi(file, content)) {
        const parsed = parseOpenApi(file, content);
        if (parsed && !seen.has(file)) {
          seen.add(file);
          out.push({
            kind: 'openapi',
            filePath: file,
            summary: `OpenAPI ${parsed.version} (${parsed.operations.length} operations)`,
          });
          counts.openapi++;
        }
      }
    }

    // tRPC
    if (['.ts', '.tsx'].includes(ext) && counts.trpc < cap) {
      const posixPath = posix.normalize(file.replace(/\\/g, '/'));
      const byPath = TRPC_PATH_RE.test(posixPath);
      const content = safeRead(file);
      if (!content) continue;
      const byContent = TRPC_CONTENT_RE.test(content);
      if ((byPath || byContent) && !seen.has(file)) {
        const procCount = countTrpcProcedures(content);
        if (procCount > 0) {
          seen.add(file);
          out.push({
            kind: 'trpc',
            filePath: file,
            summary: `tRPC router (${procCount} procedures)`,
          });
          counts.trpc++;
          continue;
        }
      }
    }

    // GraphQL template literal inside .ts/.js files
    if (
      ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext) &&
      counts.graphql < cap
    ) {
      const content = safeRead(file);
      if (!content) continue;
      if (!GRAPHQL_CONTENT_RE.test(content)) continue;
      const bodies = extractSdlBodies(file, content);
      const fields: GraphqlField[] = [];
      for (const body of bodies) fields.push(...parseGraphqlSdl(body));
      if (!fields.length) continue;
      if (seen.has(file)) continue;
      seen.add(file);
      out.push({
        kind: 'graphql',
        filePath: file,
        summary: summarizeGraphql(fields),
      });
      counts.graphql++;
    }
  }

  return { sources: out };
}

function summarizeGraphql(fields: GraphqlField[]): string {
  const q = fields.filter((f) => f.root === 'Query').length;
  const mu = fields.filter((f) => f.root === 'Mutation').length;
  const s = fields.filter((f) => f.root === 'Subscription').length;
  return `GraphQL SDL (${q}/${mu}/${s} Q/M/S fields)`;
}

// ── Generation ──────────────────────────────────────────────────────────

export async function generateContractBehaviors(
  opts: GenerateOptions,
): Promise<GenerateResult> {
  const maxPer = opts.maxBehaviorsPerSource ?? 30;
  const repoRoot = resolve(opts.repoLocalPath);

  let sources = opts.sources;
  if (!sources) {
    try {
      const disc = await discoverContractSources({ repoLocalPath: repoRoot });
      sources = disc.sources;
    } catch (e) {
      warn(`discovery failed: ${(e as Error).message}`);
      return { behaviors: [], bySource: {} };
    }
  }

  const behaviors: Behavior[] = [];
  const bySource: Record<string, number> = {};
  let idxOpenapi = 0;
  let idxTrpc = 0;
  let idxGraphql = 0;

  for (const src of sources) {
    const before = behaviors.length;
    try {
      if (src.kind === 'openapi') {
        idxOpenapi = pushOpenApiBehaviors(src.filePath, repoRoot, behaviors, idxOpenapi, maxPer);
      } else if (src.kind === 'trpc') {
        idxTrpc = pushTrpcBehaviors(src.filePath, behaviors, idxTrpc, maxPer);
      } else if (src.kind === 'graphql') {
        idxGraphql = pushGraphqlBehaviors(src.filePath, behaviors, idxGraphql, maxPer);
      }
    } catch (e) {
      warn(`source generation failed (${src.kind} ${src.filePath}): ${(e as Error).message}`);
    }
    bySource[src.filePath] = behaviors.length - before;
  }

  return { behaviors, bySource };
}

function pushOpenApiBehaviors(
  filePath: string,
  repoRoot: string,
  out: Behavior[],
  startIdx: number,
  maxPer: number,
): number {
  const content = safeRead(filePath);
  if (!content) return startIdx;

  let parsed = parseOpenApi(filePath, content);
  let degraded = false;
  if (!parsed || parsed.operations.length === 0) {
    const fallbackOps = parseOpenApiRegexFallback(content);
    if (fallbackOps.length) {
      warn(`OpenAPI parse degraded to regex fallback: ${filePath}`);
      parsed = { version: parsed?.version ?? 'unknown', operations: fallbackOps };
      degraded = true;
    }
  }
  if (!parsed) return startIdx;

  const handlerWalkLimit: WalkLimit = { visited: 0 };
  let count = 0;
  let idx = startIdx;
  for (const op of parsed.operations) {
    if (count >= maxPer) break;
    const handler = findOpenApiHandler(repoRoot, op.path, handlerWalkLimit);
    const preconditions = op.hasSecurity ? ['Auth token present'] : [];
    const paramsDesc = op.parameters.length
      ? op.parameters
          .map((p) => `${p.name}${p.type ? `:${p.type}` : ''}${p.required ? '!' : ''}`)
          .join(', ')
      : 'no parameters';

    // Pick a 2xx response if present, else the first.
    const primary =
      op.responses.find((r) => /^2\d\d$/.test(r.status)) ?? op.responses[0];
    const status = primary?.status ?? '2xx';
    const contentType = primary?.contentTypes[0] ?? 'application/json';
    const schemaSummary = primary?.description
      ? truncate(primary.description, 60)
      : contentType;

    const is2xx = /^2\d\d$/.test(status) || status === '2xx';
    const priority: Priority = is2xx && op.hasSecurity ? 'critical' : 'normal';

    const groundFiles = [filePath];
    if (handler?.file) groundFiles.push(handler.file);

    const confidence = degraded ? 0.5 : handler ? 0.9 : 0.6;

    out.push({
      id: `b-contract-openapi-${idx++}`,
      kind: 'contract',
      intent: `${op.method} ${op.path} — ${op.summary ?? 'contract'}`,
      target: {
        file: handler?.file ?? filePath,
        symbol: handler?.symbol ?? '',
      },
      preconditions,
      inputs: { description: paramsDesc },
      expected: {
        description: `Responds with ${status} and schema ${contentType}`,
        assertion: `status === ${status} && response matches ${schemaSummary}`,
      },
      priority,
      ground: { files: groundFiles, typesSeen: [], confidence },
    });
    count++;
  }

  return idx;
}

function pushTrpcBehaviors(
  filePath: string,
  out: Behavior[],
  startIdx: number,
  maxPer: number,
): number {
  const content = safeRead(filePath);
  if (!content) return startIdx;
  const procs = parseTrpc(content);
  let count = 0;
  let idx = startIdx;
  for (const proc of procs) {
    if (count >= maxPer) break;
    out.push({
      id: `b-contract-trpc-${idx++}`,
      kind: 'contract',
      intent: `tRPC ${proc.kind}: ${proc.name}`,
      target: { file: filePath, symbol: proc.name },
      preconditions: proc.isProtected ? ['Auth token present'] : [],
      inputs: { description: proc.inputShape ?? 'no input' },
      expected: {
        description: 'Succeeds with parsed output',
        assertion: `${proc.name} returns a value conforming to its output schema`,
      },
      priority: proc.isProtected ? 'critical' : 'normal',
      ground: { files: [filePath], typesSeen: [], confidence: 0.7 },
    });
    count++;
  }
  return idx;
}

function pushGraphqlBehaviors(
  filePath: string,
  out: Behavior[],
  startIdx: number,
  maxPer: number,
): number {
  const content = safeRead(filePath);
  if (!content) return startIdx;
  const bodies = extractSdlBodies(filePath, content);
  const fields: GraphqlField[] = [];
  for (const body of bodies) fields.push(...parseGraphqlSdl(body));

  let count = 0;
  let idx = startIdx;
  for (const f of fields) {
    if (count >= maxPer) break;
    const argDesc = f.args.length ? f.args.join(', ') : 'no args';
    out.push({
      id: `b-contract-graphql-${idx++}`,
      kind: 'contract',
      intent: `GraphQL ${f.root} field: ${f.name}`,
      target: { file: filePath, symbol: f.name },
      preconditions: [],
      inputs: { description: argDesc },
      expected: {
        description: `Returns ${f.returnType}`,
        assertion: `response.data.${f.name} is ${f.returnType}`,
      },
      priority: f.root === 'Mutation' ? 'critical' : 'normal',
      ground: { files: [filePath], typesSeen: [], confidence: 0.7 },
    });
    count++;
  }
  return idx;
}

// ── Misc ────────────────────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
