#!/usr/bin/env node
/**
 * code-search-daemon — long-lived indexer process.
 *
 * Boot sequence:
 *   1. Resolve unified config (defaults → file → env → CLI).
 *   2. Build/refresh the index for the workspace.
 *   3. Start the file watcher (debounced batches → forceIndex).
 *   4. Start the UDS JSON-RPC server.
 *   5. Trap SIGINT/SIGTERM, drain, exit.
 *
 * IPC: see {@link RpcServer} for method set.
 */

import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveCodeSearchConfig, parseCliFlags, toKnowledgeConfig } from '../core/config.js';
import { InProcessBackend } from '../backends/in-process.js';
import { daemonSocketPath } from '../backends/index.js';
import { RpcServer } from './rpc-server.js';
import { Watcher } from './watcher.js';

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const { patch, rest } = parseCliFlags(argv);

  let workspaceDir: string | null = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--workspace' && rest[i + 1]) workspaceDir = rest[++i];
  }
  if (!workspaceDir) {
    process.stderr.write('code-search-daemon: missing --workspace <path>\n');
    process.exit(2);
  }
  if (!existsSync(workspaceDir)) {
    process.stderr.write(`code-search-daemon: workspace does not exist: ${workspaceDir}\n`);
    process.exit(2);
  }

  const cfg = resolveCodeSearchConfig({ cli: patch, workspaceDir });
  const project = workspaceDir.split('/').filter(Boolean).pop() || 'project';
  const knowledge = toKnowledgeConfig(cfg);
  const backend = new InProcessBackend({
    project,
    workspaceDir,
    knowledge,
    preferDaemon: false,
  });

  process.stderr.write(`[code-search-daemon] starting for project="${project}", workspace=${workspaceDir}\n`);
  process.stderr.write('[code-search-daemon] building initial index...\n');
  await backend.forceIndex();
  process.stderr.write('[code-search-daemon] initial index ready.\n');

  // PID file so other tools / tests can detect the daemon.
  const socketPath = daemonSocketPath(cfg.storage.dataDir, project);
  const pidFile = join(cfg.storage.dataDir, 'daemon', `${project}.pid`);

  // Lazy queue depth — counts pending reindex jobs so /status reports
  // something useful. We don't parallelize indexing (the underlying
  // KnowledgeIndexer is sequential per project).
  let queueDepth = 0;
  let indexing = false;
  const triggerReindex = async (): Promise<void> => {
    if (indexing) {
      queueDepth++;
      return;
    }
    indexing = true;
    try {
      while (queueDepth >= 0) {
        await backend.forceIndex();
        if (queueDepth === 0) break;
        queueDepth--;
      }
    } catch (err) {
      process.stderr.write(`[code-search-daemon] reindex failed: ${err instanceof Error ? err.message : err}\n`);
    } finally {
      indexing = false;
    }
  };

  const watcher = new Watcher({
    workspaceDir,
    ignorePatterns: cfg.indexing.ignorePatterns,
    debounceMs: cfg.indexing.debounceMs,
  });
  watcher.on('error', (err) => {
    process.stderr.write(`[code-search-daemon] watcher error: ${err instanceof Error ? err.message : err}\n`);
  });
  watcher.onBatch((batch) => {
    process.stderr.write(`[code-search-daemon] reindex queued (${batch.changed.size} changed, ${batch.removed.size} removed)\n`);
    queueDepth++;
    void triggerReindex();
  });
  watcher.start();

  const startedAt = Date.now();
  const rpc = new RpcServer({
    socketPath,
    handlers: {
      'search.code': (p) => backend.search(p.query, { mode: (p.mode as 'hybrid' | 'vector' | 'bm25') ?? 'hybrid', maxResults: p.maxResults, repos: p.repos }),
      'index.status': async () => {
        const s = await backend.status();
        return { ...s, watching: true, queueDepth };
      },
      'index.force': async (p) => {
        await backend.forceIndex({ force: p?.force });
        return backend.status();
      },
      'index.invalidate': async (p) => {
        await backend.invalidate(p.paths ?? []);
        return { ok: true } as const;
      },
      'health': () => ({ ok: true as const, uptime: Math.floor((Date.now() - startedAt) / 1000) }),
    },
  });
  await rpc.start();
  process.stderr.write(`[code-search-daemon] RPC listening on ${socketPath}\n`);

  try {
    writeFileSync(pidFile, String(process.pid), 'utf-8');
  } catch { /* non-fatal */ }

  const shutdown = async (signal: string): Promise<void> => {
    process.stderr.write(`[code-search-daemon] ${signal} — draining...\n`);
    watcher.stop();
    await rpc.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  process.stderr.write(`code-search-daemon fatal: ${err instanceof Error ? err.stack : err}\n`);
  process.exit(1);
});
