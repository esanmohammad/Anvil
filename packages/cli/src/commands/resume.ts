import { Command } from 'commander';
import { RunStore, IndexReader } from '../run/index.js';
import { getFFDirs } from '../home.js';
import { resumePipeline } from '../pipeline/resume.js';
import { info, error as logError, success, warn } from '../logger.js';
import { join } from 'node:path';

export const resumeCommand = new Command('resume')
  .argument('<run-id>', 'Run ID to resume')
  .option('--force', 'Resume even if drift detected')
  .description('Resume a failed or cancelled pipeline run')
  .action(async (runId: string, opts: { force?: boolean }) => {
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

      // 2. Validate it's resumable
      if (record.status === 'completed') {
        logError(`Run ${runId} is already completed — nothing to resume`);
        process.exitCode = 1;
        return;
      }
      if (record.status === 'running') {
        logError(`Run ${runId} is still running — cannot resume`);
        process.exitCode = 1;
        return;
      }
      if (record.status !== 'failed' && record.status !== 'cancelled') {
        logError(`Run ${runId} has status "${record.status}" — only failed or cancelled runs can be resumed`);
        process.exitCode = 1;
        return;
      }

      info(`Resuming run ${runId} for project "${record.project}"...`);

      // 3. Resume pipeline
      const result = await resumePipeline({
        runId,
        project: record.project,
        agentRunner: { run: async () => ({ output: '', tokenEstimate: 0 }) },
        runStore,
        force: opts.force,
      });

      // 4. Display result
      if (result.driftReport?.hasDrift) {
        warn('Drift was detected but --force was used');
      }

      success(`Resumed from stage ${result.resumedFromStage} — status: ${result.result.status}`);
    } catch (err) {
      logError(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    }
  });
