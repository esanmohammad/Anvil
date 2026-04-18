import { Command } from 'commander';
import { RunStore, IndexReader, STAGE_NAMES } from '../run/index.js';
import { getFFDirs } from '../home.js';
import { info, error as logError, success } from '../logger.js';
import { join } from 'node:path';

export const retryCommand = new Command('retry')
  .argument('<run-id>', 'Run ID to retry')
  .option('--from <stage>', 'Stage number to retry from (0-7)', (v: string) => parseInt(v, 10))
  .description('Retry a pipeline run from a specific stage')
  .action(async (runId: string, opts: { from?: number }) => {
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

      // 2. Cannot retry a running pipeline
      if (record.status === 'running') {
        logError(`Run ${runId} is still running — cannot retry`);
        process.exitCode = 1;
        return;
      }

      // 3. Validate --from stage range
      const fromStage = opts.from ?? 0;
      if (fromStage < 0 || fromStage > 7) {
        logError(`Invalid stage number: ${fromStage}. Must be 0-7.`);
        process.exitCode = 1;
        return;
      }

      info(`Retrying run ${runId} from stage ${fromStage} (${STAGE_NAMES[fromStage]})`);

      // 4. Keep artifacts for stages before --from, clear stages >= --from
      const updatedStages = record.stages.map((stage, idx) => {
        if (idx >= fromStage) {
          return { ...stage, status: 'pending' as const, completedAt: undefined, cost: undefined };
        }
        return stage;
      });

      // 5. Update run record to restart from specified stage
      await runStore.updateRun(runId, {
        status: 'running',
        stages: updatedStages,
      });

      success(`Run ${runId} queued for retry from stage ${fromStage} (${STAGE_NAMES[fromStage]})`);
    } catch (err) {
      logError(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });
