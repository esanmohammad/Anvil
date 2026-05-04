/**
 * Contract Guard Phase 2 — consumer call-site detection.
 *
 * Walks a repo and extracts HTTP / gRPC / GraphQL client call sites using
 * regex + small heuristics (no tree-sitter dep). The output is a flat list
 * of `ConsumerCall`s that the graph-builder can later match against the
 * `Contract` objects produced by Phase 1.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';

export type SupportedLanguage = 'ts' | 'js' | 'py' | 'go' | 'java' | 'unknown';
export type CallKind = 'http' | 'grpc' | 'graphql';

export interface ConsumerCall {
  repoName: string;
  filePath: string; // repo-relative POSIX path
  lineNumber: number;
  language: SupportedLanguage;
  kind: CallKind;
  method?: string;
  urlOrPath?: string;
  matchedEndpointId?: string;
  snippet: string;
}

export interface DetectOptions {
  maxFileSize?: number;
  maxFiles?: number;
}

const DEFAULT_MAX_FILE_SIZE = 256 * 1024; // 256 KB
const DEFAULT_MAX_FILES = 5000;
const MAX_DEPTH = 12;

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'vendor',
  'target',
  'out',
  '.cache',
  'coverage',
  '.next',
  '.venv',
  'venv',
  '__pycache__',
]);

const LANG_BY_EXT: Record<string, SupportedLanguage> = {
  '.ts': 'ts',
  '.tsx': 'ts',
  '.mts': 'ts',
  '.cts': 'ts',
  '.js': 'js',
  '.jsx': 'js',
  '.mjs': 'js',
  '.cjs': 'js',
  '.py': 'py',
  '.go': 'go',
  '.java': 'java',
};

function languageOf(file: string): SupportedLanguage {
  return LANG_BY_EXT[extname(file).toLowerCase()] ?? 'unknown';
}

interface Candidate {
  absPath: string;
  relPath: string;
  language: SupportedLanguage;
}

function walk(root: string, maxFiles: number, maxFileSize: number): Candidate[] {
  const out: Candidate[] = [];

  const visit = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    if (out.length >= maxFiles) return;

    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      if (out.length >= maxFiles) return;
      if (SKIP_DIRS.has(entry) || entry.startsWith('.')) continue;
      const abs = join(dir, entry);
      let st;
      try {
        st = statSync(abs);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        visit(abs, depth + 1);
        continue;
      }
      if (!st.isFile()) continue;
      if (st.size > maxFileSize) continue;
      const lang = languageOf(entry);
      if (lang === 'unknown') continue;
      out.push({
        absPath: abs,
        relPath: relative(root, abs).split('\\').join('/'),
        language: lang,
      });
    }
  };

  visit(root, 0);
  return out;
}

function makeSnippet(line: string): string {
  const trimmed = line.trim();
  return trimmed.length > 80 ? `${trimmed.slice(0, 77)}...` : trimmed;
}

function stripQuotes(s: string): string {
  return s.replace(/^['"`]|['"`]$/g, '');
}

/* ── Regex patterns ──────────────────────────────────────────────────────── */

// `fetch('url', { method: 'POST' })` or `fetch(url)` or `fetch(\`/x\`)`
const RE_FETCH =
  /\bfetch\s*\(\s*(['"`])([^'"`]+)\1(?:\s*,\s*\{[^}]*method\s*:\s*(['"])([A-Z]+)\3)?/;

// `axios.get('url', ...)` / `axios.post(...)` etc.
const RE_AXIOS = /\baxios\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*(['"`])([^'"`]+)\2/i;

// `fetch(new URL('...'))`
const RE_FETCH_NEWURL = /\bfetch\s*\(\s*new\s+URL\s*\(\s*(['"`])([^'"`]+)\1/;

// GraphQL tagged template — capture the first ~200 chars to sniff the operation name.
const RE_GQL_TAG = /\bgql\s*`([^`]{0,500})`/;

// gRPC-ish: `client.MethodName(` or `stub.MethodName(` where MethodName is CamelCase.
const RE_GRPC_JS = /\b(?:client|stub|grpcClient|svcClient)\s*\.\s*([A-Z][A-Za-z0-9_]+)\s*\(/;

// Python requests.get("url", ...)
const RE_PY_REQUESTS =
  /\b(?:requests|httpx|session)\s*\.\s*(get|post|put|patch|delete|head|options)\s*\(\s*(['"])([^'"]+)\2/i;

// Python grpc: stub.MethodName(req)
const RE_PY_GRPC = /\b(?:stub|client)\s*\.\s*([A-Z][A-Za-z0-9_]+)\s*\(/;

// Go: http.Get("url") or http.Post(...)
const RE_GO_HTTP_SHORT = /\bhttp\s*\.\s*(Get|Post|PostForm|Head)\s*\(\s*"([^"]+)"/;

// Go: http.NewRequest("GET", url, ...)
const RE_GO_NEWREQ = /\bhttp\s*\.\s*NewRequest(?:WithContext)?\s*\(\s*(?:[^,]+,\s*)?"([A-Z]+)"\s*,\s*"([^"]+)"/;

// Go grpc: client.MethodName(ctx,
const RE_GO_GRPC = /\b(?:client|stub|svc)\s*\.\s*([A-Z][A-Za-z0-9_]+)\s*\(\s*ctx\b/;

// Java okhttp: .url("https://...")
const RE_JAVA_OKHTTP_URL = /\.url\s*\(\s*"([^"]+)"\s*\)/;

// Java RestTemplate: restTemplate.getForObject("url", ...)
const RE_JAVA_REST =
  /\b(?:restTemplate|rest)\s*\.\s*(getForObject|postForObject|getForEntity|postForEntity|exchange|put|delete)\s*\(\s*"([^"]+)"/;

/* ── Per-language extraction ─────────────────────────────────────────────── */

function extractFromJsTs(
  line: string,
  lineNumber: number,
  rel: string,
  repo: string,
  lang: SupportedLanguage,
): ConsumerCall[] {
  const out: ConsumerCall[] = [];
  const snippet = makeSnippet(line);

  let m: RegExpExecArray | null;

  m = RE_FETCH.exec(line);
  if (m) {
    out.push({
      repoName: repo,
      filePath: rel,
      lineNumber,
      language: lang,
      kind: 'http',
      method: (m[4] ?? 'GET').toUpperCase(),
      urlOrPath: stripQuotes(m[2]),
      snippet,
    });
  }

  m = RE_FETCH_NEWURL.exec(line);
  if (m) {
    out.push({
      repoName: repo,
      filePath: rel,
      lineNumber,
      language: lang,
      kind: 'http',
      method: 'GET',
      urlOrPath: stripQuotes(m[2]),
      snippet,
    });
  }

  m = RE_AXIOS.exec(line);
  if (m) {
    out.push({
      repoName: repo,
      filePath: rel,
      lineNumber,
      language: lang,
      kind: 'http',
      method: m[1].toUpperCase(),
      urlOrPath: stripQuotes(m[3]),
      snippet,
    });
  }

  m = RE_GQL_TAG.exec(line);
  if (m) {
    const body = m[1];
    const opMatch = /\b(?:query|mutation|subscription)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(body) ??
      /\{\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(body);
    out.push({
      repoName: repo,
      filePath: rel,
      lineNumber,
      language: lang,
      kind: 'graphql',
      method: opMatch ? opMatch[1] : undefined,
      urlOrPath: opMatch ? opMatch[1] : undefined,
      snippet,
    });
  }

  m = RE_GRPC_JS.exec(line);
  if (m && !/\.(get|post|put|delete|patch|head|options)\b/i.test(line)) {
    // Avoid double-matching axios / http methods.
    out.push({
      repoName: repo,
      filePath: rel,
      lineNumber,
      language: lang,
      kind: 'grpc',
      method: m[1],
      urlOrPath: m[1],
      snippet,
    });
  }

  return out;
}

function extractFromPython(
  line: string,
  lineNumber: number,
  rel: string,
  repo: string,
): ConsumerCall[] {
  const out: ConsumerCall[] = [];
  const snippet = makeSnippet(line);

  const m1 = RE_PY_REQUESTS.exec(line);
  if (m1) {
    out.push({
      repoName: repo,
      filePath: rel,
      lineNumber,
      language: 'py',
      kind: 'http',
      method: m1[1].toUpperCase(),
      urlOrPath: stripQuotes(m1[3]),
      snippet,
    });
    return out;
  }

  const m2 = RE_PY_GRPC.exec(line);
  if (m2 && /stub|grpc/i.test(line)) {
    out.push({
      repoName: repo,
      filePath: rel,
      lineNumber,
      language: 'py',
      kind: 'grpc',
      method: m2[1],
      urlOrPath: m2[1],
      snippet,
    });
  }

  return out;
}

function extractFromGo(
  line: string,
  lineNumber: number,
  rel: string,
  repo: string,
): ConsumerCall[] {
  const out: ConsumerCall[] = [];
  const snippet = makeSnippet(line);

  let m = RE_GO_HTTP_SHORT.exec(line);
  if (m) {
    const verb = m[1].toUpperCase();
    out.push({
      repoName: repo,
      filePath: rel,
      lineNumber,
      language: 'go',
      kind: 'http',
      method: verb === 'POSTFORM' ? 'POST' : verb,
      urlOrPath: m[2],
      snippet,
    });
    return out;
  }

  m = RE_GO_NEWREQ.exec(line);
  if (m) {
    out.push({
      repoName: repo,
      filePath: rel,
      lineNumber,
      language: 'go',
      kind: 'http',
      method: m[1].toUpperCase(),
      urlOrPath: m[2],
      snippet,
    });
    return out;
  }

  m = RE_GO_GRPC.exec(line);
  if (m) {
    out.push({
      repoName: repo,
      filePath: rel,
      lineNumber,
      language: 'go',
      kind: 'grpc',
      method: m[1],
      urlOrPath: m[1],
      snippet,
    });
  }

  return out;
}

function extractFromJava(
  line: string,
  lineNumber: number,
  rel: string,
  repo: string,
): ConsumerCall[] {
  const out: ConsumerCall[] = [];
  const snippet = makeSnippet(line);

  const m1 = RE_JAVA_REST.exec(line);
  if (m1) {
    const verbMap: Record<string, string> = {
      getForObject: 'GET',
      getForEntity: 'GET',
      postForObject: 'POST',
      postForEntity: 'POST',
      put: 'PUT',
      delete: 'DELETE',
      exchange: 'GET',
    };
    out.push({
      repoName: repo,
      filePath: rel,
      lineNumber,
      language: 'java',
      kind: 'http',
      method: verbMap[m1[1]] ?? 'GET',
      urlOrPath: m1[2],
      snippet,
    });
    return out;
  }

  const m2 = RE_JAVA_OKHTTP_URL.exec(line);
  if (m2) {
    out.push({
      repoName: repo,
      filePath: rel,
      lineNumber,
      language: 'java',
      kind: 'http',
      method: 'GET', // verb usually on a nearby line; leave default
      urlOrPath: m2[1],
      snippet,
    });
  }

  return out;
}

function extractFromFile(
  text: string,
  rel: string,
  repo: string,
  lang: SupportedLanguage,
): ConsumerCall[] {
  const lines = text.split(/\r?\n/);
  const out: ConsumerCall[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.length > 2000) continue; // pathological line
    const ln = i + 1;
    if (lang === 'ts' || lang === 'js') {
      out.push(...extractFromJsTs(line, ln, rel, repo, lang));
    } else if (lang === 'py') {
      out.push(...extractFromPython(line, ln, rel, repo));
    } else if (lang === 'go') {
      out.push(...extractFromGo(line, ln, rel, repo));
    } else if (lang === 'java') {
      out.push(...extractFromJava(line, ln, rel, repo));
    }
  }
  return out;
}

/* ── Entry point ─────────────────────────────────────────────────────────── */

export function detectConsumerCalls(
  repoLocalPath: string,
  repoName: string,
  opts?: DetectOptions,
): ConsumerCall[] {
  const maxFileSize = opts?.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  const maxFiles = opts?.maxFiles ?? DEFAULT_MAX_FILES;

  const candidates = walk(repoLocalPath, maxFiles, maxFileSize);
  const calls: ConsumerCall[] = [];

  for (const c of candidates) {
    let text: string;
    try {
      text = readFileSync(c.absPath, 'utf8');
    } catch {
      continue;
    }
    calls.push(...extractFromFile(text, c.relPath, repoName, c.language));
  }

  return calls;
}
