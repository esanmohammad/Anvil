import { Command } from 'commander';
import { RunStore, IndexReader } from '../run/index.js';
import { getFFDirs } from '../home.js';
import { info, error as logError, success } from '../logger.js';
import { join } from 'node:path';

export const cancelCommand = new Command('cancel')
  .argument('<run-id>', 'Run ID to cancel')
  .description('Cancel a running pipeline')
  .action(async (runId: string) => {
    try {
      const anvilDirs = getFFDirs();
      const runStore = new RunStore(anvilDirs.runs);
      const indexReader = new IndexReader(join(anvilDirs.runs, 'index.jsonl'));

      // 1. Find run record
      const record = await indexReader.findRun(runId);
      if (!record) {
        logError(`Run not found: ${runId}`);
        process.exitCode = 1;
        return;
      }

      // 2. Validate it's cancelable
      if (record.status === 'completed') {
        logError(`Run ${runId} is already completed — cannot cancel`);
        process.exitCode = 1;
        return;
      }
      if (record.status === 'cancelled') {
        logError(`Run ${runId} is already cancelled`);
        process.exitCode = 1;
        return;
      }
      if (record.status === 'failed') {
        logError(`Run ${runId} has already failed — nothing to cancel`);
        process.exitCode = 1;
        return;
      }

      info(`Cancelling run ${runId}...`);

      // 3. Mark as cancelled — preserve artifacts
      await runStore.updateRun(runId, { status: 'cancelled' });

      // 4. Display confirmation
      success(`Run ${runId} has been cancelled. Artifacts have been preserved.`);
    } catch (err) {
      logError(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });
