/**
 * Built-in tool executor used by non-Claude adapters (Ollama, future
 * OpenAI/Gemini agentic paths). Mirrors the minimum subset of Claude
 * CLI's tools that the pipeline build/validate/ship stages need.
 *
 * Permission model:
 *   - Construction takes an `allowedTools: Set<string>` that comes from
 *     the stage policy (see core-pipeline/src/routing/stage-permissions).
 *   - `listSchemas()` filters BEFORE returning so the model never even
 *     learns about denied tools.
 *   - `execute()` re-checks (defense in depth) and rejects denied calls
 *     with `isError: true` rather than throwing — the adapter feeds the
 *     rejection back to the model so it can recover.
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, statSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

import type { ToolCall, ToolSchema } from '../types.js';
import type { ExecCtx, ToolClass, ToolExecutor, ToolResult } from './types.js';
import { PathEscapeError, resolveSafe } from './path-guard.js';

// Read truncation cap — keeps a stray `read_file` of a 50 MB log from
// blowing context. The model gets a clear marker; it can re-read with
// offset/limit if it needs more.
const MAX_READ_BYTES = 256 * 1024;
const DEFAULT_BASH_TIMEOUT_MS = 60_000;
const MAX_BASH_TIMEOUT_MS = 300_000;

// ───────────────────────────────────────────────────────────────────────
// Schema definitions — OpenAI-tools-compatible JSON Schema
// ───────────────────────────────────────────────────────────────────────

const SCHEMAS: Record<string, { schema: ToolSchema; class: ToolClass }> = {
  read_file: {
    class: 'read',
    schema: {
      name: 'read_file',
      description: 'Read a file from the working directory. Optionally specify offset (1-indexed start line) and limit (max lines) to page through large files.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative or absolute path inside the working directory' },
          offset: { type: 'integer', description: '1-indexed starting line (optional)' },
          limit: { type: 'integer', description: 'Max number of lines to return (optional)' },
        },
        required: ['path'],
      },
    },
  },
  write_file: {
    class: 'write',
    schema: {
      name: 'write_file',
      description: 'Write content to a file (creating it if needed). Overwrites existing content. Parent directory is auto-created.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
      },
    },
  },
  edit: {
    class: 'write',
    schema: {
      name: 'edit',
      description: 'Replace exact text in an existing file. old_string MUST match exactly (whitespace included). Set replace_all to replace every occurrence.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          old_string: { type: 'string' },
          new_string: { type: 'string' },
          replace_all: { type: 'boolean' },
        },
        required: ['path', 'old_string', 'new_string'],
      },
    },
  },
  bash: {
    class: 'exec',
    schema: {
      name: 'bash',
      description: 'Run a shell command in the working directory. Capped to 60s default, 300s max. Returns stdout, stderr, and exit code.',
      inputSchema: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command to execute' },
          timeout_ms: { type: 'integer', description: 'Milliseconds before forced kill (max 300000)' },
        },
        required: ['command'],
      },
    },
  },
  grep: {
    class: 'read',
    schema: {
      name: 'grep',
      description: 'Search file contents using ripgrep-compatible regex. Returns matching lines with file:line prefixes.',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string', description: 'File or directory to search; defaults to working directory' },
          glob: { type: 'string', description: 'File glob filter (e.g. "*.ts")' },
        },
        required: ['pattern'],
      },
    },
  },
  glob: {
    class: 'read',
    schema: {
      name: 'glob',
      description: 'List files matching a glob pattern. Returns absolute paths sorted by modification time (newest first).',
      inputSchema: {
        type: 'object',
        properties: {
          pattern: { type: 'string', description: 'Glob like "**/*.ts"' },
          path: { type: 'string', description: 'Root to glob under; defaults to working directory' },
        },
        required: ['pattern'],
      },
    },
  },
  list: {
    class: 'read',
    schema: {
      name: 'list',
      description: 'List the contents of a directory (non-recursive). Returns one entry per line: kind size name.',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Directory to list; defaults to working directory' },
        },
      },
    },
  },
};

export const TOOL_CLASS: Readonly<Record<string, ToolClass>> = Object.fromEntries(
  Object.entries(SCHEMAS).map(([name, { class: cls }]) => [name, cls]),
);

// ───────────────────────────────────────────────────────────────────────
// Executor
// ───────────────────────────────────────────────────────────────────────

export interface BuiltinToolExecutorOpts {
  /** Names of tools the executor advertises + permits. Anything outside
   *  the set is rejected at both listSchemas() and execute(). */
  allowedTools: Iterable<string>;
  /**
   * Wave 5 — optional memory recall callback. When wired, and when
   * `recall_memory` is in `allowedTools`, the executor advertises it
   * AND routes calls to this function. Without the callback, the
   * tool isn't listed (so the agent never learns it exists).
   * Returns the stringified JSON the model sees.
   *
   * Bounded by `recallBudget` (default 3) — additional calls return
   * a "budget exhausted" sentinel so the agent can't loop on recall.
   */
  recallMemory?: (query: string, opts: { kind?: string; subtype?: string; limit?: number }) => Promise<string>;
  /** Cap on `recall_memory` invocations per executor instance. Default 3. */
  recallBudget?: number;
}

export class BuiltinToolExecutor implements ToolExecutor {
  private readonly allowed: Set<string>;
  private readonly recallMemory?: (query: string, opts: { kind?: string; subtype?: string; limit?: number }) => Promise<string>;
  private recallBudget: number;

  constructor(opts: BuiltinToolExecutorOpts) {
    this.allowed = new Set(opts.allowedTools);
    this.recallMemory = opts.recallMemory;
    this.recallBudget = opts.recallBudget ?? 3;
  }

  listSchemas(): ToolSchema[] {
    const out: ToolSchema[] = [];
    for (const [name, def] of Object.entries(SCHEMAS)) {
      if (this.allowed.has(name)) out.push(def.schema);
    }
    if (this.recallMemory && this.allowed.has('recall_memory')) {
      out.push(RECALL_MEMORY_SCHEMA);
    }
    return out;
  }

  async execute(call: ToolCall, ctx: ExecCtx): Promise<ToolResult> {
    if (call.name === 'recall_memory') {
      if (!this.recallMemory || !this.allowed.has('recall_memory')) {
        return { isError: true, content: `Tool "recall_memory" is not permitted in this stage.` };
      }
      if (this.recallBudget <= 0) {
        return {
          isError: true,
          content: 'recall_memory budget exhausted for this stage. Use what was already injected.',
        };
      }
      this.recallBudget -= 1;
      try {
        const args = call.arguments ?? {};
        const query = requireString(args.query, 'query');
        const opts = {
          kind: typeof args.kind === 'string' ? args.kind : undefined,
          subtype: typeof args.subtype === 'string' ? args.subtype : undefined,
          limit: typeof args.limit === 'number' ? Math.min(20, Math.max(1, args.limit)) : 5,
        };
        const content = await this.recallMemory(query, opts);
        return { isError: false, content };
      } catch (err) {
        return { isError: true, content: errorMessage(err) };
      }
    }

    if (!this.allowed.has(call.name)) {
      return { isError: true, content: `Tool "${call.name}" is not permitted in this stage.` };
    }
    const handler = HANDLERS[call.name];
    if (!handler) {
      return { isError: true, content: `Unknown tool "${call.name}".` };
    }
    try {
      return await handler(call.arguments ?? {}, ctx);
    } catch (err) {
      return { isError: true, content: errorMessage(err) };
    }
  }
}

const RECALL_MEMORY_SCHEMA: ToolSchema = {
  name: 'recall_memory',
  description:
    'Search project memory for past lessons / patterns / PR episodes. Returns top-N matches ranked by hybrid retrieval (BM25 + vector + 1-hop graph expansion). Bounded budget per stage — use deliberately.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language query (e.g., "authentication patterns", "error handling for OOM")' },
      kind: { type: 'string', enum: ['semantic', 'episodic', 'profile'], description: 'Filter by memory kind (optional)' },
      subtype: {
        type: 'string',
        enum: ['fix-pattern', 'success', 'approach', 'flaky-test', 'performance', 'manual'],
        description: 'Filter by semantic subtype (optional)',
      },
      limit: { type: 'integer', description: 'Max results (1-20, default 5)' },
    },
    required: ['query'],
  },
};

// ───────────────────────────────────────────────────────────────────────
// Handlers
// ───────────────────────────────────────────────────────────────────────

type Handler = (args: Record<string, unknown>, ctx: ExecCtx) => Promise<ToolResult>;

const HANDLERS: Record<string, Handler> = {
  read_file: async (args, ctx) => {
    const path = requireString(args.path, 'path');
    const safe = resolveSafe(path, ctx.workingDir);
    const stat = statSync(safe);
    if (!stat.isFile()) return { isError: true, content: `"${path}" is not a regular file.` };
    if (stat.size > MAX_READ_BYTES * 16) {
      return { isError: true, content: `"${path}" is ${stat.size} bytes — too large to read in one call. Use offset/limit.` };
    }

    const raw = readFileSync(safe, 'utf8');
    const offset = optionalInteger(args.offset, 'offset');
    const limit = optionalInteger(args.limit, 'limit');

    let content: string;
    if (offset !== undefined || limit !== undefined) {
      const lines = raw.split('\n');
      const start = Math.max(0, (offset ?? 1) - 1);
      const end = limit !== undefined ? start + limit : lines.length;
      content = lines.slice(start, end).join('\n');
    } else if (raw.length > MAX_READ_BYTES) {
      content = raw.slice(0, MAX_READ_BYTES) + `\n\n[truncated — ${raw.length - MAX_READ_BYTES} more bytes]`;
    } else {
      content = raw;
    }
    return { isError: false, content };
  },

  write_file: async (args, ctx) => {
    const path = requireString(args.path, 'path');
    const content = requireString(args.content, 'content', { allowEmpty: true });
    const safe = resolveSafe(path, ctx.workingDir);
    mkdirSync(dirname(safe), { recursive: true });
    writeFileSync(safe, content, 'utf8');
    return { isError: false, content: `Wrote ${content.length} bytes to ${safe}` };
  },

  edit: async (args, ctx) => {
    const path = requireString(args.path, 'path');
    const oldString = requireString(args.old_string, 'old_string', { allowEmpty: true });
    const newString = requireString(args.new_string, 'new_string', { allowEmpty: true });
    const replaceAll = args.replace_all === true;

    const safe = resolveSafe(path, ctx.workingDir);
    if (!existsSync(safe)) return { isError: true, content: `File not found: ${path}` };
    const original = readFileSync(safe, 'utf8');

    if (oldString === '') {
      return { isError: true, content: 'old_string must not be empty for edit; use write_file to create new content.' };
    }
    if (!original.includes(oldString)) {
      return { isError: true, content: `old_string not found in ${path}.` };
    }

    let updated: string;
    if (replaceAll) {
      updated = original.split(oldString).join(newString);
    } else {
      const occurrences = original.split(oldString).length - 1;
      if (occurrences > 1) {
        return { isError: true, content: `old_string matched ${occurrences} times in ${path} — set replace_all:true or pick a more unique anchor.` };
      }
      updated = original.replace(oldString, newString);
    }

    writeFileSync(safe, updated, 'utf8');
    return { isError: false, content: `Edited ${path} (${updated.length - original.length >= 0 ? '+' : ''}${updated.length - original.length} bytes)` };
  },

  bash: async (args, ctx) => {
    const command = requireString(args.command, 'command');
    const timeoutMs = clampInteger(
      optionalInteger(args.timeout_ms, 'timeout_ms') ?? DEFAULT_BASH_TIMEOUT_MS,
      1, MAX_BASH_TIMEOUT_MS,
    );
    return runBash(command, ctx, timeoutMs);
  },

  grep: async (args, ctx) => {
    const pattern = requireString(args.pattern, 'pattern');
    const target = args.path !== undefined ? resolveSafe(requireString(args.path, 'path'), ctx.workingDir) : ctx.workingDir;
    const globArg = optionalString(args.glob, 'glob');
    const argv = ['--no-heading', '--line-number', '--color=never', '-e', pattern];
    if (globArg) argv.push('--glob', globArg);
    argv.push(target);
    return runProcess('rg', argv, ctx, DEFAULT_BASH_TIMEOUT_MS);
  },

  glob: async (args, ctx) => {
    const pattern = requireString(args.pattern, 'pattern');
    const target = args.path !== undefined ? resolveSafe(requireString(args.path, 'path'), ctx.workingDir) : ctx.workingDir;
    // ripgrep's `--files --glob` is a portable globber that respects .gitignore.
    return runProcess('rg', ['--files', '--glob', pattern, target], ctx, DEFAULT_BASH_TIMEOUT_MS);
  },

  list: async (args, ctx) => {
    const target = args.path !== undefined ? resolveSafe(requireString(args.path, 'path'), ctx.workingDir) : ctx.workingDir;
    const stat = statSync(target);
    if (!stat.isDirectory()) return { isError: true, content: `"${target}" is not a directory.` };
    const entries = readdirSync(target, { withFileTypes: true });
    const lines = entries
      .map((e) => {
        try {
          const full = `${target}/${e.name}`;
          const s = statSync(full);
          const kind = e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'symlink' : 'file';
          return `${kind}\t${s.size}\t${e.name}`;
        } catch {
          return `unknown\t0\t${e.name}`;
        }
      })
      .sort();
    return { isError: false, content: lines.join('\n') || '(empty)' };
  },
};

// ───────────────────────────────────────────────────────────────────────
// Process runners
// ───────────────────────────────────────────────────────────────────────

async function runBash(command: string, ctx: ExecCtx, timeoutMs: number): Promise<ToolResult> {
  // Use `sh -c` so the model can pipe + redirect, but never invoke an
  // interactive shell. Args are NOT interpolated by the agent — the
  // entire command string comes from the model in one piece.
  return runProcess('sh', ['-c', command], ctx, timeoutMs);
}

async function runProcess(
  cmd: string,
  argv: string[],
  ctx: ExecCtx,
  timeoutMs: number,
): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve) => {
    const child = spawn(cmd, argv, {
      cwd: ctx.workingDir,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: false,                   // never re-interpret cmd via /bin/sh
    });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const STDIO_CAP = 64 * 1024;

    const finish = (content: string, isError: boolean) => {
      if (finished) return;
      finished = true;
      try { child.kill('SIGKILL'); } catch { /* already exited */ }
      resolve({ isError, content });
    };

    const timer = setTimeout(() => finish(stdout + stderr + `\n\n[timed out after ${timeoutMs}ms]`, true), timeoutMs);

    const onAbort = () => finish(stdout + stderr + '\n\n[aborted]', true);
    if (ctx.abortSignal.aborted) {
      clearTimeout(timer);
      onAbort();
      return;
    }
    ctx.abortSignal.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (b: Buffer) => {
      if (stdout.length < STDIO_CAP) stdout += b.toString('utf8').slice(0, STDIO_CAP - stdout.length);
    });
    child.stderr?.on('data', (b: Buffer) => {
      if (stderr.length < STDIO_CAP) stderr += b.toString('utf8').slice(0, STDIO_CAP - stderr.length);
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      ctx.abortSignal.removeEventListener('abort', onAbort);
      finish(`spawn error: ${err.message}`, true);
    });
    child.on('exit', (code, signal) => {
      clearTimeout(timer);
      ctx.abortSignal.removeEventListener('abort', onAbort);
      const tail = stdout + (stderr ? `\n\n[stderr]\n${stderr}` : '');
      const body = tail || '(no output)';
      const exitLine = signal ? `\n\n[killed by ${signal}]` : code !== 0 ? `\n\n[exit ${code}]` : '';
      finish(body + exitLine, code !== 0 || signal !== null);
    });
  });
}

// ───────────────────────────────────────────────────────────────────────
// Argument validation helpers
// ───────────────────────────────────────────────────────────────────────

function requireString(v: unknown, name: string, opts: { allowEmpty?: boolean } = {}): string {
  if (typeof v !== 'string') throw new Error(`Argument "${name}" must be a string`);
  if (!opts.allowEmpty && v.length === 0) throw new Error(`Argument "${name}" must not be empty`);
  return v;
}
function optionalString(v: unknown, name: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  return requireString(v, name);
}
function optionalInteger(v: unknown, name: string): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'number' || !Number.isInteger(v)) throw new Error(`Argument "${name}" must be an integer`);
  return v;
}
function clampInteger(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

function errorMessage(err: unknown): string {
  if (err instanceof PathEscapeError) return err.message;
  return err instanceof Error ? err.message : String(err);
}
