// ship-only command — run ship stage for a completed run

import { Command } from 'commander';
import { RunStore } from '../run/run-store.js';
import { getFFDirs } from '../home.js';

export interface ShipOnlyDeps {
  runStore?: RunStore;
  shipFn?: (runId: string, project: string) => Promise<void>;
}

export function createShipOnlyCommand(deps: ShipOnlyDeps = {}): Command {
  return new Command('ship-only')
    .description('Ship a completed run without re-running pipeline')
    .argument('<run-id>', 'The run ID to ship')
    .option('--keep-sandbox', 'Keep sandbox alive after shipping')
    .action(async (runId: string, opts: { keepSandbox?: boolean }) => {
      try {
        const dirs = getFFDirs();
        const store = deps.runStore ?? new RunStore(dirs.runs);

        // Load the run record — we need to find the project from the index
        const run = await loadRunById(store, runId, dirs.runs);
        if (!run) {
          process.stderr.write(`Run not found: ${runId}\n`);
          process.exitCode = 1;
          return;
        }

        // Validate build stage completed
        const buildStage = run.stages.find((s) => s.name === 'build');
        if (!buildStage || buildStage.status !== 'completed') {
          process.stderr.write(
            `Cannot ship: build stage has not completed for run ${runId}\n`,
          );
          process.exitCode = 1;
          return;
        }

        // Validate validate stage completed
        const validateStage = run.stages.find((s) => s.name === 'validate');
        if (!validateStage || validateStage.status !== 'completed') {
          process.stderr.write(
            `Cannot ship: validate stage has not completed for run ${runId}\n`,
          );
          process.exitCode = 1;
          return;
        }

        if (deps.shipFn) {
          await deps.shipFn(runId, run.project);
        } else {
          process.stderr.write(
            `Shipping run ${runId} for project ${run.project}...\n`,
          );
          // Mark ship stage as running
          await store.updateStage(runId, 7, {
            status: 'running',
            startedAt: new Date().toISOString(),
          });

          process.stderr.write(
            `Ship stage started for ${runId}. Use 'ff status ${runId}' to track progress.\n`,
          );
        }
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      }
    });
}

async function loadRunById(
  store: RunStore,
  runId: string,
  runsBasePath: string,
): Promise<import('../run/types.js').RunRecord | null> {
  // Try to find the run in the index
  const { existsSync, readFileSync } = await import('node:fs');
  const { join } = await import('node:path');
  const indexPath = join(runsBasePath, 'index.jsonl');

  if (!existsSync(indexPath)) {
    return null;
  }

  const content = readFileSync(indexPath, 'utf-8');
  const lines = content.split('\n').filter((l) => l.trim());

  for (const line of lines) {
    try {
      const record = JSON.parse(line);
      if (record.id === runId) {
        return store.loadRun(runId, record.project);
      }
    } catch {
      continue;
    }
  }

  return null;
}

// Default export for commander registration
export const shipOnlyCommand = createShipOnlyCommand();
