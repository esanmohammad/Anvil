#!/usr/bin/env node
/**
 * code-search — standalone CLI for the code-search product.
 *
 * Subcommands:
 *   code-search index [path] [--force]   one-shot index for path (or cwd)
 *   code-search query <text> [options]   run a search and print top-K
 *   code-search status                   show daemon / index health
 *   code-search reset [--project p]      drop the index for a project
 *   code-search daemon ...               spawn the long-lived daemon
 *   code-search serve [--port|--auth]    start the HTTP MCP server
 *   code-search mcp ...                  start the stdio MCP server
 *   code-search --print-config           print resolved config (redacted)
 *   code-search --help                   help
 *
 * The CLI lives in the same package as the MCP server so a single npm
 * install gets the whole product. Each subcommand is a tiny dispatcher
 * that defers to the existing implementations.
 */

import { spawn } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join, resolve as resolvePath } from 'node:path';
import {
  resolveCodeSearchConfig,
  parseCliFlags,
  printConfig,
  toKnowledgeConfig,
} from '../core/config.js';
import {
  indexFromPath,
  KnowledgeIndexer,
  getKnowledgeBasePath,
  loadProfile,
} from '@esankhan3/anvil-knowledge-core';
import { pickBackend, daemonSocketPath } from '../backends/index.js';

type Format = 'text' | 'json' | 'jsonl';

const HELP_TEXT = `code-search — multi-repo code intelligence

USAGE:
  code-search <command> [options]
  code-search --print-config       print resolved configuration (secrets redacted)

COMMANDS:
  index [path]                     index a directory (default: cwd)
  query <text>                     hybrid search; print top-K
  status                           show index + daemon health
  reset [--project <name>]         drop the project's index
  daemon --workspace <path>        spawn the long-running daemon
  serve [--port N] [--auth mode]   HTTP MCP server
  mcp                              stdio MCP server (Claude Desktop)

QUERY OPTIONS:
  --mode hybrid|vector|bm25        retrieval mode (default: hybrid)
  --top-k N                        max results (default: 10)
  --repo <name>                    restrict to a repo (repeatable)
  --format text|json|jsonl         output format (default: text)
  --project <name>                 project namespace (default: cwd basename)

CONFIG:
  Every leaf in CodeSearchConfig is settable via --<dotted-path>.
  Examples:
    --embedding.provider codestral
    --retrieval.max-chunks 20
    --no-indexing.auto-index
`;

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    process.stdout.write(HELP_TEXT);
    process.exit(0);
  }

  if (argv[0] === '--print-config') {
    const { patch } = parseCliFlags(argv.slice(1));
    const cfg = resolveCodeSearchConfig({ cli: patch });
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

function takeFlag(rest: string[], name: string): string | undefined {
  const idx = rest.indexOf(name);
  if (idx < 0) return undefined;
  return rest[idx + 1];
}

function projectFromPath(p: string): string {
  return resolvePath(p).split('/').filter(Boolean).pop() || 'project';
}

async function cmdIndex(rest: string[]): Promise<void> {
  const { patch, rest: positional } = parseCliFlags(rest);
  const path = positional.find((a) => !a.startsWith('--')) ?? process.cwd();
  const cfg = resolveCodeSearchConfig({ cli: patch, workspaceDir: path });
  const project = takeFlag(positional, '--project') ?? projectFromPath(path);
  const force = positional.includes('--force');
  process.stderr.write(`[code-search] indexing ${path} as project "${project}"...\n`);
  const stats = await indexFromPath(project, resolvePath(path), {
    force,
    config: toKnowledgeConfig(cfg),
    onProgress: (m) => process.stderr.write(`[code-search] ${m}\n`),
  });
  process.stdout.write(JSON.stringify({
    project,
    chunks: stats.totalChunks,
    repos: stats.repos.length,
    crossRepoEdges: stats.crossRepoEdges,
    durationMs: stats.indexDurationMs,
  }, null, 2) + '\n');
}

const VALID_MODES = new Set<'hybrid' | 'vector' | 'bm25'>(['hybrid', 'vector', 'bm25']);

async function cmdQuery(rest: string[]): Promise<void> {
  const { patch, rest: positional } = parseCliFlags(rest);
  const queryText = positional.find((a) => !a.startsWith('--') && !a.startsWith('-'));
  if (!queryText) {
    process.stderr.write('code-search query: missing <text>\n');
    process.exit(2);
  }
  // F4 — validate --mode so a typo (e.g. `--mode hybird`) fails fast
  // instead of silently falling through to in-process retrieval.
  const rawMode = takeFlag(positional, '--mode') ?? 'hybrid';
  if (!VALID_MODES.has(rawMode as 'hybrid' | 'vector' | 'bm25')) {
    process.stderr.write(
      `code-search query: invalid --mode "${rawMode}". ` +
      `Valid modes: ${[...VALID_MODES].join(', ')}.\n`,
    );
    process.exit(2);
  }
  const mode = rawMode as 'hybrid' | 'vector' | 'bm25';
  const topK = parseInt(takeFlag(positional, '--top-k') ?? '10', 10);
  const repos = positional.reduce<string[]>((acc, a, i) => {
    if (a === '--repo' && positional[i + 1]) acc.push(positional[i + 1]);
    return acc;
  }, []);
  const format: Format = (takeFlag(positional, '--format') ?? 'text') as Format;
  const project = takeFlag(positional, '--project') ?? projectFromPath(process.cwd());

  const cfg = resolveCodeSearchConfig({ cli: patch });
  const socketPath = daemonSocketPath(cfg.storage.dataDir, project);
  const backend = await pickBackend({
    project,
    workspaceDir: process.cwd(),
    knowledge: toKnowledgeConfig(cfg),
    preferDaemon: !cfg.daemon.disabled,
    socketPath,
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
  const { patch } = parseCliFlags(rest);
  const cfg = resolveCodeSearchConfig({ cli: patch });
  const project = takeFlag(rest, '--project') ?? projectFromPath(process.cwd());
  const indexer = new KnowledgeIndexer();
  const stats = await indexer.getStats(project);
  const socketPath = daemonSocketPath(cfg.storage.dataDir, project);
  process.stdout.write(JSON.stringify({
    project,
    dataDir: cfg.storage.dataDir,
    daemonSocket: socketPath,
    daemonAlive: existsSync(socketPath),
    totalChunks: stats.totalChunks,
    embeddingProvider: stats.embeddingProvider,
    lastIndexedAt: stats.lastIndexed || null,
    repos: stats.repos,
    profilesAvailable: stats.repos.map((r) => ({
      name: r.name,
      hasProfile: !!loadProfile(project, r.name),
    })),
  }, null, 2) + '\n');
}

async function cmdReset(rest: string[]): Promise<void> {
  const project = takeFlag(rest, '--project') ?? projectFromPath(process.cwd());
  const basePath = getKnowledgeBasePath(project);
  if (existsSync(basePath)) {
    rmSync(basePath, { recursive: true, force: true });
    process.stderr.write(`[code-search] removed ${basePath}\n`);
  } else {
    process.stderr.write(`[code-search] nothing to remove at ${basePath}\n`);
  }
}

async function cmdDaemon(rest: string[]): Promise<void> {
  // Forward to the daemon binary directly so the daemon process is detached.
  const here = new URL(import.meta.url);
  const daemonEntry = join(new URL('..', here).pathname, 'daemon', 'index.js');
  const child = spawn(process.execPath, [daemonEntry, ...rest], {
    stdio: 'inherit',
    detached: false,
  });
  child.on('exit', (code) => process.exit(code ?? 0));
}

async function cmdServe(rest: string[]): Promise<void> {
  // Same as `code-search-mcp --serve <args>`. We re-import the entry so we
  // can share argv-parsing logic.
  process.argv = [process.argv[0], process.argv[1], '--serve', ...rest];
  await import('../index.js');
}

async function cmdMcp(rest: string[]): Promise<void> {
  process.argv = [process.argv[0], process.argv[1], ...rest];
  await import('../index.js');
}

main().catch((err) => {
  process.stderr.write(`code-search fatal: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(1);
});
