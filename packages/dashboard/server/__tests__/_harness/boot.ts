/**
 * bootDashboard — wraps `startDashboardServer` for tests.
 *
 * Each call:
 *   - Allocates a fresh tmp ANVIL_HOME (cleaned in `stop()`).
 *   - Sets process.env.ANVIL_HOME BEFORE the dashboard-server module is
 *     imported (the module reads it at load time, so this matters).
 *   - Starts the server on an ephemeral port (port: 0).
 *   - Returns a harness with `url`, `connectClient`, `stop`.
 *
 * Caveat: dashboard-server.ts reads ANVIL_HOME once at module-load. Multiple
 * bootDashboard() calls in the same process share the FIRST tmp dir set. For
 * the canary test (single boot) this is fine. Phase 1 tests that run several
 * boots will use a single shared ANVIL_HOME with per-scenario subdirs.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { socketIoClient, type DashboardClient } from './dashboard-client.js';
import { FakeAgentManager } from './fake-agent-manager.js';
import type { DashboardServerDeps } from '../../dashboard-server.js';

export interface DashboardHarness {
  url: string;
  port: number;
  homeDir: string;
  staticDir: string;
  /** The fake agent manager wired into this boot. Use `.spawn()` outputs
   *  + `.emitActivity / emitOutput / emitDone / emitError` to script
   *  scenario timelines. Returned as the concrete subclass for test access. */
  agentManager: FakeAgentManager;
  /**
   * Connect a DashboardClient. After Phase 8 socket.io is the only
   * transport; the optional `transport` arg is kept for forward
   * compatibility with future transport experiments.
   */
  connectClient(opts?: { origin?: string }): Promise<DashboardClient>;
  stop(): Promise<void>;
}

export interface BootOpts {
  /** Override the tmp HOME path. Default: mkdtemp under os.tmpdir(). */
  homeDir?: string;
  /** Override the static dir. Default: an empty tmp subdir. */
  staticDir?: string;
  /** Skip cleanup of the tmp dirs on stop (useful for local debugging). */
  keepTmp?: boolean;
  /** Inject a pre-configured FakeAgentManager. Default: new one per boot. */
  agentManager?: FakeAgentManager;
}

export async function bootDashboard(opts: BootOpts = {}): Promise<DashboardHarness> {
  const homeDir = opts.homeDir ?? mkdtempSync(join(tmpdir(), 'anvil-canary-'));
  process.env.ANVIL_HOME = homeDir;

  // Pre-create the dirs the server expects to find / write under.
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(join(homeDir, 'runs'), { recursive: true });
  mkdirSync(join(homeDir, 'projects'), { recursive: true });
  // Seed an empty state.json so initial broadcastState() doesn't ENOENT.
  writeFileSync(
    join(homeDir, 'state.json'),
    JSON.stringify({ activePipeline: null, lastUpdated: new Date().toISOString() }),
  );

  const staticDir = opts.staticDir ?? mkdtempSync(join(tmpdir(), 'anvil-static-'));
  writeFileSync(join(staticDir, 'index.html'), '<html><body>canary</body></html>');

  const agentManager = opts.agentManager ?? new FakeAgentManager();
  const deps: DashboardServerDeps = { agentManager };

  // Dynamic import — env var must be set first.
  const { startDashboardServer } = await import('../../dashboard-server.js');
  const handle = await startDashboardServer({
    port: 0,
    staticDir,
    open: false,
  }, deps);

  const httpUrl = `http://localhost:${handle.port}`;

  return {
    url: httpUrl,
    port: handle.port,
    homeDir,
    staticDir,
    agentManager,
    async connectClient(connOpts?: { origin?: string }): Promise<DashboardClient> {
      // Default Origin to the actual server port so the server's CORS
      // allowlist accepts the connection.
      const origin = connOpts?.origin ?? httpUrl;
      return socketIoClient(httpUrl, { origin });
    },
    async stop(): Promise<void> {
      await handle.stop();
      if (!opts.keepTmp) {
        try { rmSync(homeDir, { recursive: true, force: true }); } catch { /* ok */ }
        try { rmSync(staticDir, { recursive: true, force: true }); } catch { /* ok */ }
      }
    },
  };
}

/**
 * Schedule a hard process.exit shortly after this is called. Workaround for
 * dashboard-server internals that hold onto handles we don't yet clean up
 * (sqlite stores, cost handlers, etc.) — they'll be migrated to Emittery-
 * based services in Phase 2/3 where their lifecycle is explicit.
 *
 * Call this from a test file's top-level `after()` hook AFTER all per-test
 * teardown has run, so node:test's reporter has flushed TAP output.
 */
export function forceExitAfterTests(delayMs = 200): void {
  setTimeout(() => process.exit(0), delayMs).unref();
}

