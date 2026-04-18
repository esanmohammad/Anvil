// Parallel per-project stage runner

import type { AffectedProject } from './types.js';

export interface ParallelResult<T> {
  project: string;
  status: 'completed' | 'failed';
  result?: T;
  error?: string;
}

export type ParallelStatus = 'completed' | 'partial' | 'failed';

export interface ParallelRunResult<T> {
  status: ParallelStatus;
  results: ParallelResult<T>[];
}

export async function runParallelPerProject<T>(
  projects: AffectedProject[],
  stageFn: (project: AffectedProject) => Promise<T>,
  concurrency: number = 4,
): Promise<ParallelRunResult<T>> {
  const results: ParallelResult<T>[] = [];

  // Process in batches according to concurrency limit
  for (let i = 0; i < projects.length; i += concurrency) {
    const batch = projects.slice(i, i + concurrency);

    const settled = await Promise.allSettled(
      batch.map(async (project): Promise<ParallelResult<T>> => {
        try {
          const result = await stageFn(project);
          return { project: project.name, status: 'completed', result };
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          return { project: project.name, status: 'failed', error };
        }
      }),
    );

    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        results.push(outcome.value);
      } else {
        // This shouldn't happen since we catch inside, but handle defensively
        results.push({
          project: 'unknown',
          status: 'failed',
          error: outcome.reason?.message ?? String(outcome.reason),
        });
      }
    }
  }

  const completedCount = results.filter((r) => r.status === 'completed').length;
  let status: ParallelStatus;
  if (completedCount === results.length) {
    status = 'completed';
  } else if (completedCount === 0) {
    status = 'failed';
  } else {
    status = 'partial';
  }

  return { status, results };
}
