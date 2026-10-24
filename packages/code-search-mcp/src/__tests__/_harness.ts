/**
 * Shared helpers for the end-to-end tests that spawn the real built binaries.
 *
 * Every spawned process gets a hermetic env: a temp HOME (so no user
 * ~/.code-search/config.yaml leaks in), a temp CODE_SEARCH_DATA_DIR, LLM off,
 * reranker off, and an OpenAI-compatible fake embedder on a local port.
 *
 * Ports are fixed per test file (node --test runs files in parallel) and all
 * live in 47380–47399:
 *   server-cli-args 47381-47382 · server-lifecycle 47383-47385 ·
 *   http-auth 47386 · http-index 47387-47388 · remote-proxy 47389 ·
 *   fake embedders 47390-47396 · cluster 47397-47398
 */

import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('..', import.meta.url));

export const BIN = {
  mcp: join(DIST, 'index.js'),
  cli: join(DIST, 'cli', 'index.js'),
  daemon: join(DIST, 'daemon', 'index.js'),
};

/** Short temp dir (UDS paths are capped at ~104 bytes on macOS). */
export function tmp(prefix = 'cs-'): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export interface FakeEmbedder {
  url: string;
  calls: () => number;
  close: () => Promise<void>;
}

/** OpenAI-compatible POST /v1/embeddings returning deterministic vectors. */
export async function startFakeEmbedder(port: number, opts: { dims?: number; delayMs?: number } = {}): Promise<FakeEmbedder> {
  const dims = opts.dims ?? 16;
  let calls = 0;
  const server: Server = createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => { body += c.toString(); });
    req.on('end', () => {
      calls++;
      const input: string[] = (() => { try { return JSON.parse(body).input ?? []; } catch { return []; } })();
      const data = input.map((text, index) => {
        const v = new Array(dims).fill(0).map((_, i) => {
          let h = 0;
          for (let j = i; j < text.length; j += dims) h = (h * 31 + text.charCodeAt(j)) % 1000;
          return h / 1000 + 0.001;
        });
        return { object: 'embedding', index, embedding: v };
      });
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data, model: 'fake' }));
      }, opts.delayMs ?? 0);
    });
  });
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${port}`,
    calls: () => calls,
    close: () => new Promise<void>((r) => { server.closeAllConnections(); server.close(() => r()); }),
  };
}

/** Create a committed git repo `<root>/<name>` holding `files`. */
export function makeRepo(root: string, name: string, files: Record<string, string>): string {
  const dir = join(root, name);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...a], { cwd: dir, stdio: 'pipe' });
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'init');
  return dir;
}

/** Two repos sharing a topic name (→ one cross-repo edge). */
export function makeWorkspace(root: string): string {
  const ws = join(root, 'ws');
  makeRepo(ws, 'orders', {
    'package.json': '{"name":"orders","version":"1.0.0"}',
    'src/orders.ts': [
      "export const topic = 'orders.created';",
      'export function createOrder(id: string) {',
      '  return { id, status: "new" };',
      '}',
      'export function welcomeEmail(user: string) {',
      '  return `welcome email for ${user}`;',
      '}',
    ].join('\n'),
  });
  makeRepo(ws, 'billing', {
    'package.json': '{"name":"billing","version":"1.0.0"}',
    'src/billing.ts': [
      "const topic = 'orders.created';",
      'export function chargeOrder(orderId: string, cents: number) {',
      '  return { orderId, cents, charged: true };',
      '}',
    ].join('\n'),
  });
  return ws;
}

/** Hermetic env for a spawned binary. */
export function baseEnv(opts: { home: string; dataDir?: string; embedderUrl?: string; extra?: Record<string, string> }): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/^(CODE_SEARCH_|ANVIL_|OPENAI_|ANTHROPIC_|MISTRAL_|VOYAGE_|COHERE_|OLLAMA_|OTEL_|GITHUB_TOKEN|CLAUDE_BIN)/.test(k)) continue;
    env[k] = v;
  }
  env.HOME = opts.home;
  env.CODE_SEARCH_LLM_MODE = 'none';
  env.CODE_SEARCH_RERANKER_PROVIDER = 'none';
  if (opts.dataDir) env.CODE_SEARCH_DATA_DIR = opts.dataDir;
  if (opts.embedderUrl) {
    env.CODE_SEARCH_EMBEDDING_PROVIDER = 'custom';
    env.CODE_SEARCH_EMBEDDING_BASE_URL = opts.embedderUrl;
    env.CODE_SEARCH_EMBEDDING_MODEL = 'fake';
    env.CODE_SEARCH_EMBEDDING_DIMENSIONS = '16';
  }
  return { ...env, ...opts.extra };
}

export interface Proc {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  waitForStderr: (re: RegExp, ms?: number) => Promise<void>;
  kill: () => void;
}

export function spawnProc(bin: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string): Proc {
  const child = spawn(process.execPath, [bin, ...args], { env, cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout!.on('data', (d: Buffer) => { out += d.toString(); });
  child.stderr!.on('data', (d: Buffer) => { err += d.toString(); });
  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => {
    child.on('exit', (code, signal) => r({ code, signal }));
  });
  return {
    child,
    stdout: () => out,
    stderr: () => err,
    exited,
    waitForStderr: (re, ms = 20_000) => waitFor(() => re.test(err), ms, `stderr ${re}\n--- stderr ---\n${err}`),
    kill: () => { try { child.kill('SIGKILL'); } catch { /* gone */ } },
  };
}

/** Run a binary to completion. */
export async function run(bin: string, args: string[], env: NodeJS.ProcessEnv, cwd?: string, timeoutMs = 60_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const p = spawnProc(bin, args, env, cwd);
  p.child.stdin!.end();
  const timer = setTimeout(() => p.kill(), timeoutMs);
  const { code } = await p.exited;
  clearTimeout(timer);
  return { code, stdout: p.stdout(), stderr: p.stderr() };
}

export async function waitFor(fn: () => boolean | Promise<boolean>, ms = 20_000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    try { if (await fn()) return; } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Wait for a child to exit; SIGKILL it if it doesn't within `ms`. */
export async function exitWithin(p: Proc, ms: number): Promise<{ code: number | null; signal: NodeJS.Signals | null } | 'timeout'> {
  let timer: NodeJS.Timeout | undefined;
  const r = await Promise.race([
    p.exited,
    new Promise<'timeout'>((res) => { timer = setTimeout(() => res('timeout'), ms); }),
  ]);
  clearTimeout(timer);
  if (r === 'timeout') p.kill();
  return r;
}

export async function getJson(url: string, init?: RequestInit): Promise<{ status: number; body: any; headers: Headers }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body, headers: res.headers };
}
