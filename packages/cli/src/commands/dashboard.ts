import { Command } from 'commander';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { info, error } from '../logger.js';

export const dashboardCommand = new Command('dashboard')
  .description('Open the Anvil dashboard')
  .option('-p, --port <port>', 'Port to serve on', '5173')
  .option('--no-open', 'Do not open browser automatically')
  .action(async (opts: { port: string; open: boolean }) => {
    const cliDir = dirname(fileURLToPath(import.meta.url));
    const dashboardDir = resolve(cliDir, '../../..', 'dashboard');

    if (!existsSync(resolve(dashboardDir, 'package.json'))) {
      error('Dashboard package not found. Run from the Anvil monorepo.');
      process.exitCode = 1;
      return;
    }

    // Build frontend if needed
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
