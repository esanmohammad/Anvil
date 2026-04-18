import { Command } from 'commander';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { info, error } from '../logger.js';

/**
 * Resolve the dashboard package directory.
 * Works in both monorepo dev (sibling package) and npx/global install
 * (resolved via node_modules from @anvil-dev/dashboard dependency).
 */
function resolveDashboardDir(): string | null {
  // 1. Try resolving as an installed dependency (npx / global install)
  try {
    const require = createRequire(import.meta.url);
    const pkgPath = require.resolve('@anvil-dev/dashboard/package.json');
    return dirname(pkgPath);
  } catch { /* not installed as dependency */ }

  // 2. Fallback: monorepo sibling (development)
  const cliDir = dirname(fileURLToPath(import.meta.url));
  const monorepoPath = resolve(cliDir, '../../..', 'dashboard');
  if (existsSync(resolve(monorepoPath, 'package.json'))) {
    return monorepoPath;
  }

  return null;
}

export const dashboardCommand = new Command('dashboard')
  .description('Open the Anvil dashboard')
  .option('-p, --port <port>', 'Port to serve on', '5173')
  .option('--no-open', 'Do not open browser automatically')
  .action(async (opts: { port: string; open: boolean }) => {
    const dashboardDir = resolveDashboardDir();

    if (!dashboardDir) {
      error('Dashboard package not found. Install @anvil-dev/dashboard or run from the Anvil monorepo.');
      process.exitCode = 1;
      return;
    }

    // Build frontend if needed (only in monorepo dev — published packages include pre-built dist)
    const staticDir = resolve(dashboardDir, 'dist');
    if (!existsSync(resolve(staticDir, 'index.html'))) {
      info('Building dashboard...');
      try {
        execSync('npx vite build', { cwd: dashboardDir, stdio: 'inherit' });
      } catch {
        error('Dashboard build failed.');
        process.exitCode = 1;
        return;
      }
    }

    const port = parseInt(opts.port, 10);
    info(`Starting dashboard server on http://localhost:${port}`);

    // Import and start the combined HTTP+WS dashboard server
    const { startDashboardServer } = await import(
      resolve(dashboardDir, 'server', 'dashboard-server.js')
    );

    await startDashboardServer({
      port,
      staticDir,
      open: opts.open,
    });
  });
