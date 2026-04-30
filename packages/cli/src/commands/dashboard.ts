import { Command } from 'commander';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { info, error } from '../logger.js';

/**
 * Load `~/.anvil/observability.yaml` (if present) and apply its top-level
 * scalar entries to process.env. Shell-exported values win — we never
 * overwrite an env var that is already set. Lets users start the dashboard
 * with `anvil-loc dashboard` and still get OTLP tracing into the local
 * Jaeger stack at infra/observability/docker-compose.yml.
 */
function loadObservabilityConfig(): void {
  const anvilHome = process.env.ANVIL_HOME || process.env.FF_HOME || join(homedir(), '.anvil');
  const cfgPath = join(anvilHome, 'observability.yaml');
  if (!existsSync(cfgPath)) return;
  try {
    const parsed = parseYaml(readFileSync(cfgPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (process.env[key] !== undefined) continue;
      if (value === null || value === undefined) continue;
      process.env[key] = String(value);
    }
  } catch (err) {
    error(`Failed to parse ${cfgPath}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * Resolve the dashboard directory.
 * Published package: bundled at dist/dashboard (sibling of this file's compiled location).
 * Monorepo dev: sibling package at packages/dashboard.
 */
function resolveDashboardDir(): { dir: string; staticDir: string; serverEntry: string } | null {
  const cliDir = dirname(fileURLToPath(import.meta.url));

  // 1. Published layout: dist/commands/dashboard.js → dist/dashboard/{dist,server}
  const bundled = resolve(cliDir, '..', 'dashboard');
  if (existsSync(resolve(bundled, 'dist', 'index.html'))
    && existsSync(resolve(bundled, 'server', 'dashboard-server.js'))) {
    return {
      dir: bundled,
      staticDir: resolve(bundled, 'dist'),
      serverEntry: resolve(bundled, 'server', 'dashboard-server.js'),
    };
  }

  // 2. Monorepo dev: packages/cli/dist/commands/dashboard.js → packages/dashboard
  const monorepo = resolve(cliDir, '../../..', 'dashboard');
  if (existsSync(resolve(monorepo, 'package.json'))) {
    return {
      dir: monorepo,
      staticDir: resolve(monorepo, 'dist'),
      serverEntry: resolve(monorepo, 'server', 'dashboard-server.js'),
    };
  }

  return null;
}

export const dashboardCommand = new Command('dashboard')
  .description('Open the Anvil dashboard')
  .option('-p, --port <port>', 'Port to serve on', '5173')
  .option('--no-open', 'Do not open browser automatically')
  .action(async (opts: { port: string; open: boolean }) => {
    loadObservabilityConfig();

    const resolved = resolveDashboardDir();

    if (!resolved) {
      error('Dashboard assets not found. Reinstall @anvil-dev/anvil or run from the Anvil monorepo.');
      process.exitCode = 1;
      return;
    }

    if (!existsSync(resolve(resolved.staticDir, 'index.html'))) {
      info('Building dashboard...');
      try {
        execSync('npx vite build', { cwd: resolved.dir, stdio: 'inherit' });
      } catch {
        error('Dashboard build failed.');
        process.exitCode = 1;
        return;
      }
    }

    const port = parseInt(opts.port, 10);
    info(`Starting dashboard server on http://localhost:${port}`);

    const { startDashboardServer } = await import(resolved.serverEntry);

    await startDashboardServer({
      port,
      staticDir: resolved.staticDir,
      open: opts.open,
    });
  });
