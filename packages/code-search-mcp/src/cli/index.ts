#!/usr/bin/env node
/**
 * code-search — standalone CLI for the code-search product.
 *
 * Subcommands:
 *   code-search index [path] [--force]   one-shot index for path (or cwd)
 *   code-search query <text> [options]   run a search and print top-K
 *   code-search status                   show daemon / index health
 *   code-search reset [--project p]      drop the index for a project
 *   code-search daemon ...               run the long-lived daemon
 *   code-search serve [path] [--port|--auth]  start the HTTP MCP server
 *   code-search mcp [path]               start the stdio MCP server
 *   code-search --print-config           print resolved config (redacted)
 *   code-search --help                   help
 *
 * The CLI lives in the same package as the MCP server so a single npm
 * install gets the whole product. Each subcommand is a tiny dispatcher
 * that defers to the existing implementations.
 */

import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import { dirname, join, resolve as resolvePath, basename } from 'node:path';
import {
  resolveCodeSearchConfig,
  parseCliFlags,
  printConfig,
  redactSecrets,
  toKnowledgeConfig,
  exportDataDir,
  type CodeSearchConfig,
} from '../core/config.js';
import { validateProjectName } from '../core/project-name.js';
import {
  indexFromPath,
  KnowledgeIndexer,
  getBlobStore,
  getKnowledgeBasePath,
  loadProfile,
} from '@esankhan3/anvil-knowledge-core';
import { pickBackend, daemonSocketPath, DaemonBackend } from '../backends/index.js';
import { configureLogger, getComponentLogger } from '../observability/logger.js';

const log = getComponentLogger('code-search');

type Format = 'text' | 'json' | 'jsonl';
const FORMATS = new Set<Format>(['text', 'json', 'jsonl']);

const HELP_TEXT = `code-search — multi-repo code intelligence

USAGE:
  code-search <command> [options]
  code-search --print-config       print resolved configuration (secrets redacted)

COMMANDS:
  index [path]                     index a directory (default: cwd)
  query <text>                     hybrid search; print top-K
  status                           show index + daemon health
  reset [--project <name>]         drop the project's index
  daemon --workspace <path>        run the long-running daemon
  serve [path] [--port N] [--auth mode]   HTTP MCP server
  mcp [path]                       stdio MCP server over local repos (default: cwd)
  mcp --remote <url>               stdio proxy to a remote code-search server

INDEX OPTIONS:
  --project <name>                 project namespace (default: path basename)
  --force                          full re-index

QUERY OPTIONS:
  --mode hybrid|vector|bm25        retrieval mode (default: hybrid)
  --top-k N                        max results (default: 10)
  --repo <name>                    restrict to a repo (repeatable)
  --format text|json|jsonl         output format (default: text)
  --project <name>                 project namespace (default: cwd basename)
  --no-daemon                      search in-process even if a daemon is running

CONFIG:
  Every leaf in CodeSearchConfig is settable via --<dotted-path>.
  Examples:
    --embedding.provider codestral
    --retrieval.max-chunks 20
    --no-indexing.auto-index
`;

function usageError(msg: string): never {
  process.stderr.write(`code-search: ${msg}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }

  if (argv[0] === '--print-config') {
    const { cfg } = parseCommand('--print-config', argv.slice(1), {}, process.cwd());
    process.stdout.write(printConfig(cfg) + '\n');
    process.exit(0);
  }

  const sub = argv[0];
  const rest = argv.slice(1);

  switch (sub) {
    case 'index':   return await cmdIndex(rest);
    case 'query':   return await cmdQuery(rest);
    case 'status':  return await cmdStatus(rest);
    case 'reset':   return await cmdReset(rest);
    case 'daemon':  return await cmdDaemon(rest);
    case 'serve':   return await cmdServe(rest);
    case 'mcp':     return await cmdMcp(rest);
    default:
      process.stderr.write(`unknown subcommand: ${sub}\n${HELP_TEXT}`);
      process.exit(2);
  }
}

interface CommandSpec {
  /** Flags that take a value (`--repo` may repeat). */
  values?: string[];
  /** Boolean flags. */
  bools?: string[];
  maxPositionals?: number;
}

interface ParsedCommand {
  cfg: CodeSearchConfig;
  values: Map<string, string[]>;
  bools: Set<string>;
  positionals: string[];
}

/**
 * Split a subcommand's argv into config flags (→ resolved config, with the
 * workspace layer from `workspaceDir` or the first positional), the
 * subcommand's own flags, and positionals — regardless of order. Unknown or
 * misplaced flags exit 2.
 */
function parseCommand(cmd: string, argv: string[], spec: CommandSpec, workspaceDir?: string): ParsedCommand {
  const { patch, rest, unknown } = parseCliFlags(argv);
  if (unknown.length) usageError(`${cmd}: unknown flag(s): ${unknown.join(', ')}`);

  const values = new Map<string, string[]>();
  const bools = new Set<string>();
  const positionals: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--help' || a === '-h') {
      process.stdout.write(HELP_TEXT);
      process.exit(0);
    }
    if (spec.values?.includes(a)) {
      const v = rest[i + 1];
      if (v === undefined || v.startsWith('--')) usageError(`${cmd}: ${a} needs a value`);
      values.set(a, [...(values.get(a) ?? []), v]);
      i++;
    } else if (spec.bools?.includes(a)) {
      bools.add(a);
    } else if (a.startsWith('-') && a.length > 1 && Number.isNaN(Number(a))) {
      usageError(`${cmd}: unknown flag ${a}`);
    } else {
      positionals.push(a);
    }
  }
  if (spec.maxPositionals !== undefined && positionals.length > spec.maxPositionals) {
    usageError(`${cmd}: unexpected argument(s): ${positionals.slice(spec.maxPositionals).join(' ')}`);
  }

  const cfg = resolveCodeSearchConfig({ cli: patch, workspaceDir: workspaceDir ?? positionals[0] ?? process.cwd() });
  configureLogger({ structured: cfg.telemetry.structuredLogs });
  return { cfg, values, bools, positionals };
}

function flag(p: ParsedCommand, name: string): string | undefined {
  const v = p.values.get(name);
  return v?.[v.length - 1];
}

function projectArg(p: ParsedCommand, fallbackDir: string): string {
  const name = flag(p, '--project') ?? basename(resolvePath(fallbackDir));
  try {
    return validateProjectName(name);
  } catch (err) {
    usageError((err as Error).message);
  }
}

async function cmdIndex(rest: string[]): Promise<void> {
  const p = parseCommand('index', rest, { values: ['--project'], bools: ['--force'], maxPositionals: 1 });
  const path = resolvePath(p.positionals[0] ?? process.cwd());
  exportDataDir(p.cfg);
  const project = projectArg(p, path);
  const knowledge = toKnowledgeConfig(p.cfg);
  log.info(`indexing ${path} as project "${project}"...`);
  const stats = await indexFromPath(project, path, {
    force: p.bools.has('--force'),
    config: knowledge,
    onProgress: (m) => log.info(m),
  });
  // indexFromPath returns the embed stage's stats; the cross-repo edge count
  // comes from the graph stage, recorded in the stats rollup.
  const rollup = await new KnowledgeIndexer().getStats(project, knowledge);
  process.stdout.write(JSON.stringify({
    project,
    chunks: stats.totalChunks,
    repos: stats.repos.length,
    crossRepoEdges: rollup.crossRepoEdges,
    durationMs: stats.indexDurationMs,
  }, null, 2) + '\n');
}

const VALID_MODES = new Set<'hybrid' | 'vector' | 'bm25'>(['hybrid', 'vector', 'bm25']);

async function cmdQuery(rest: string[]): Promise<void> {
  const p = parseCommand('query', rest, {
    values: ['--project', '--mode', '--top-k', '--format', '--repo'],
    bools: ['--no-daemon'],
  }, process.cwd());
  const queryText = p.positionals.join(' ');
  if (!queryText) usageError('query: missing <text>');

  const rawMode = flag(p, '--mode') ?? 'hybrid';
  if (!VALID_MODES.has(rawMode as 'hybrid' | 'vector' | 'bm25')) {
    usageError(`query: invalid --mode "${rawMode}". Valid modes: ${[...VALID_MODES].join(', ')}.`);
  }
  const mode = rawMode as 'hybrid' | 'vector' | 'bm25';
  const rawTopK = flag(p, '--top-k') ?? '10';
  if (!/^\d+$/.test(rawTopK) || parseInt(rawTopK, 10) < 1) {
    usageError(`query: invalid --top-k "${rawTopK}" (a positive integer).`);
  }
  const topK = parseInt(rawTopK, 10);
  const format = (flag(p, '--format') ?? 'text') as Format;
  if (!FORMATS.has(format)) usageError(`query: invalid --format "${format}". Valid formats: ${[...FORMATS].join(', ')}.`);
  const repos = p.values.get('--repo') ?? [];

  exportDataDir(p.cfg);
  const project = projectArg(p, process.cwd());
  const backend = await pickBackend({
    project,
    workspaceDir: process.cwd(),
    knowledge: toKnowledgeConfig(p.cfg),
    preferDaemon: !p.cfg.daemon.disabled && !p.bools.has('--no-daemon'),
    socketPath: daemonSocketPath(p.cfg.storage.dataDir, project),
  });

  const result = await backend.search(queryText, {
    mode,
    maxResults: topK,
    repos: repos.length ? repos : undefined,
  });
  await backend.close();

  printSearchResult(result, format);
}

function printSearchResult(result: { query: string; chunks: Array<{ filePath: string; startLine: number; endLine: number; language: string; repoName: string; score: number; source: string; content: string }>; totalTokens: number }, format: Format): void {
  if (format === 'json') {
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }
  if (format === 'jsonl') {
    for (const c of result.chunks) process.stdout.write(JSON.stringify(c) + '\n');
    return;
  }
  if (result.chunks.length === 0) {
    process.stdout.write(`No results for "${result.query}"\n`);
    return;
  }
  let i = 0;
  for (const c of result.chunks) {
    i++;
    process.stdout.write(
      `### ${i}. ${c.repoName}/${c.filePath}:${c.startLine}-${c.endLine} ` +
      `(score: ${c.score.toFixed(3)}, source: ${c.source})\n` +
      '```' + c.language + '\n' + c.content + '\n```\n\n',
    );
  }
}

async function cmdStatus(rest: string[]): Promise<void> {
  const p = parseCommand('status', rest, { values: ['--project'], maxPositionals: 0 }, process.cwd());
  exportDataDir(p.cfg);
  const project = projectArg(p, process.cwd());
  const knowledge = toKnowledgeConfig(p.cfg);
  const socketPath = daemonSocketPath(p.cfg.storage.dataDir, project);
  const daemonAlive = await new DaemonBackend({ project, workspaceDir: null, knowledge, preferDaemon: true, socketPath }).ping();

  // Existence checks only — getStats on a project that was never indexed
  // would create its directories.
  const blobs = getBlobStore(project, knowledge);
  const indexed = (await blobs.exists('index_stats.json')) || (await blobs.exists('lancedb'));
  const stats = indexed ? await new KnowledgeIndexer().getStats(project, knowledge) : null;
  const profilesAvailable = stats
    ? await Promise.all(stats.repos.map(async (r) => ({ name: r.name, hasProfile: !!(await loadProfile(project, r.name, knowledge)) })))
    : [];
  process.stdout.write(JSON.stringify({
    project,
    dataDir: p.cfg.storage.dataDir,
    ...(p.cfg.storage.backends
      ? { storageBackends: redactSecrets(p.cfg.storage.backends) }
      : { kbPath: getKnowledgeBasePath(project) }),
    indexed,
    daemonSocket: socketPath,
    daemonAlive,
    totalChunks: stats?.totalChunks ?? 0,
    embeddingProvider: stats?.embeddingProvider ?? null,
    lastIndexedAt: stats?.lastIndexed || null,
    repos: stats?.repos ?? [],
    profilesAvailable,
  }, null, 2) + '\n');
}

async function cmdReset(rest: string[]): Promise<void> {
  const p = parseCommand('reset', rest, { values: ['--project'], maxPositionals: 0 }, process.cwd());
  exportDataDir(p.cfg);
  const project = projectArg(p, process.cwd());
  const dataDir = p.cfg.storage.dataDir;
  const basePath = resolvePath(getKnowledgeBasePath(project));
  // Only ever delete a project directory directly inside the data dir.
  if (dirname(basePath) !== dataDir) {
    usageError(`reset: refusing to remove ${basePath} — not a project directory inside ${dataDir}`);
  }
  if (existsSync(basePath)) {
    rmSync(basePath, { recursive: true, force: true });
    log.info(`removed ${basePath}`);
  } else {
    log.info(`nothing to remove at ${basePath}`);
  }
}

async function cmdDaemon(rest: string[]): Promise<void> {
  // Run the daemon binary as a child; this wrapper forwards termination
  // signals to it and exits with its status.
  const here = new URL(import.meta.url);
  const daemonEntry = join(new URL('..', here).pathname, 'daemon', 'index.js');
  const child = spawn(process.execPath, [daemonEntry, ...rest], {
    stdio: 'inherit',
    detached: false,
  });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(sig, () => { try { child.kill(sig); } catch { /* already gone */ } });
  }
  child.on('exit', (code, signal) => {
    process.exit(code ?? 128 + (signal ? osConstants.signals[signal] ?? 0 : 0));
  });
}

async function cmdServe(rest: string[]): Promise<void> {
  // Same as `code-search-mcp --serve <args>`. We re-import the entry so we
  // can share argv-parsing logic.
  process.argv = [process.argv[0], process.argv[1], '--serve', ...rest];
  await import('../index.js');
}

async function cmdMcp(rest: string[]): Promise<void> {
  // stdio server over local repos (cwd unless a path is given); with
  // --remote / a URL it is the stdio proxy instead.
  const remote = rest.includes('--remote') || rest.some((a) => /^https?:\/\//.test(a));
  process.argv = [process.argv[0], process.argv[1], ...(remote ? [] : ['--local']), ...rest];
  await import('../index.js');
}

main().catch((err) => {
  log.error(`fatal: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
