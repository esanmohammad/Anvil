#!/usr/bin/env node
/**
 * code-search-daemon — long-lived indexer process.
 *
 * Boot sequence:
 *   1. Resolve unified config (defaults → file → workspace file → env → CLI).
 *   2. Refuse to start if a live daemon already answers on the project's
 *      socket (one daemon per project); clear a stale socket.
 *   3. Start the UDS JSON-RPC server — binding the socket is this daemon's
 *      claim on the project — and write the pid file.
 *   4. Build/refresh the index for the workspace, then start the file
 *      watcher (debounced batches → reindex).
 *   5. On SIGINT/SIGTERM: stop the watcher, remove this daemon's own socket
 *      and pid file, exit.
 *
 * Every index run (initial, watcher batch, `index.force`) goes through one
 * serial queue, so runs never overlap and a watcher batch that arrives while
 * a run is pending folds into it.
 *
 * IPC: see {@link RpcServer} for method set.
 */

import { writeFileSync, existsSync, readFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { resolveCodeSearchConfig, parseCliFlags, toKnowledgeConfig, exportDataDir } from '../core/config.js';
import { validateProjectName } from '../core/project-name.js';
import { InProcessBackend } from '../backends/in-process.js';
import { DaemonBackend, daemonSocketPath } from '../backends/index.js';
import { configureLogger, getComponentLogger } from '../observability/logger.js';
import { RpcServer } from './rpc-server.js';
import { Watcher } from './watcher.js';

const log = getComponentLogger('code-search-daemon');

function usageError(msg: string): never {
  process.stderr.write(`code-search-daemon: ${msg}\n`);
  process.exit(2);
}

async function main(): Promise<void> {
  const { patch, rest, unknown } = parseCliFlags(process.argv.slice(2));
  if (unknown.length) usageError(`unknown flag(s): ${unknown.join(', ')}`);

  let workspaceArg: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--workspace' && rest[i + 1]) workspaceArg = rest[++i];
    else usageError(`unexpected argument: ${rest[i]} (usage: code-search-daemon --workspace <path> [--<config.path> <value>])`);
  }
  if (!workspaceArg) usageError('missing --workspace <path>');
  const workspaceDir = resolve(workspaceArg);
  if (!existsSync(workspaceDir)) usageError(`workspace does not exist: ${workspaceDir}`);

  const cfg = resolveCodeSearchConfig({ cli: patch, workspaceDir });
  configureLogger({ structured: cfg.telemetry.structuredLogs });
  exportDataDir(cfg);
  let project: string;
  try {
    project = validateProjectName(basename(workspaceDir));
  } catch (err) {
    usageError((err as Error).message);
  }
  const knowledge = toKnowledgeConfig(cfg);
  const socketPath = daemonSocketPath(cfg.storage.dataDir, project);
  const pidFile = join(cfg.storage.dataDir, 'daemon', `${project}.pid`);

  // One daemon per project: a live daemon answering on the socket owns it.
  if (existsSync(socketPath)) {
    const live = await new DaemonBackend({ project, workspaceDir, knowledge, preferDaemon: true, socketPath }).ping();
    if (live) {
      const pid = existsSync(pidFile) ? readFileSync(pidFile, 'utf-8').trim() : 'unknown';
      log.error(`a daemon for project "${project}" is already running (pid ${pid}, socket ${socketPath}) — not starting another`);
      process.exit(1);
    }
    if (process.platform !== 'win32') {
      try { unlinkSync(socketPath); } catch { /* raced away */ }
    }
  }

  const backend = new InProcessBackend({
    project,
    workspaceDir,
    knowledge,
    preferDaemon: false,
  });

  // Serial index queue. `queueDepth` counts runs queued or in progress.
  let tail: Promise<unknown> = Promise.resolve();
  let queueDepth = 0;
  let watcherRunPending = false;
  const enqueue = <T>(reason: string, run: () => Promise<T>): Promise<T> => {
    queueDepth++;
    const job = tail.then(async () => {
      log.info(`reindex started (${reason})`);
      try {
        const out = await run();
        log.info(`reindex finished (${reason})`);
        return out;
      } catch (err) {
        log.error(`reindex failed (${reason}): ${err instanceof Error ? err.message : err}`);
        throw err;
      } finally {
        queueDepth--;
      }
    });
    tail = job.catch(() => { /* reported above; keep the queue going */ });
    return job;
  };

  const watcher = new Watcher({
    workspaceDir,
    ignorePatterns: cfg.indexing.ignorePatterns,
    debounceMs: cfg.indexing.debounceMs,
  });
  watcher.on('error', (err) => {
    log.error(`watcher error: ${err instanceof Error ? err.message : err}`);
  });
  watcher.onBatch((batch) => {
    log.info(`reindex queued (${batch.changed.size} changed, ${batch.removed.size} removed)`);
    // A queued-but-not-started watcher run already covers this batch.
    if (watcherRunPending) return;
    watcherRunPending = true;
    enqueue('watcher', () => {
      watcherRunPending = false;
      return backend.forceIndex();
    }).catch(() => { /* logged by the queue */ });
  });

  const startedAt = Date.now();
  const rpc = new RpcServer({
    socketPath,
    handlers: {
      'search.code': (p) => backend.search(p.query, { mode: (p.mode as 'hybrid' | 'vector' | 'bm25') ?? 'hybrid', maxResults: p.maxResults, repos: p.repos }),
      'index.status': async () => {
        const s = await backend.status();
        return { ...s, watching: true, queueDepth };
      },
      'index.force': (p) => enqueue('rpc', () => backend.forceIndex({ force: p?.force })),
      'index.invalidate': async (p) => {
        await backend.invalidate(p?.paths ?? []);
        return { ok: true } as const;
      },
      'health': () => ({ ok: true as const, uptime: Math.floor((Date.now() - startedAt) / 1000) }),
    },
  });
  try {
    await rpc.start();
  } catch (err) {
    log.error(`cannot listen on ${socketPath}: ${err instanceof Error ? err.message : err} (another daemon for "${project}" starting?)`);
    process.exit(1);
  }
  log.info(`RPC listening on ${socketPath}`);

  try {
    mkdirSync(dirname(pidFile), { recursive: true });
    writeFileSync(pidFile, String(process.pid), 'utf-8');
  } catch { /* non-fatal */ }

  let stopping = false;
  /** Release only what this daemon owns: its socket and its pid file. */
  const stop = async (code: number): Promise<void> => {
    if (stopping) return;
    stopping = true;
    watcher.stop();
    await rpc.stop();
    try {
      if (readFileSync(pidFile, 'utf-8').trim() === String(process.pid)) unlinkSync(pidFile);
    } catch { /* already gone */ }
    process.exit(code);
  };
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      log.info(`${sig} — draining...`);
      void stop(0);
    });
  }

  log.info(`starting for project="${project}", workspace=${workspaceDir}`);
  log.info('building initial index...');
  try {
    await enqueue('initial', () => backend.forceIndex());
  } catch {
    await stop(1);
  }
  log.info('initial index ready.');
  watcher.start();
}

main().catch((err) => {
  log.error(`fatal: ${err instanceof Error ? err.stack : err}`);
  process.exit(1);
});
