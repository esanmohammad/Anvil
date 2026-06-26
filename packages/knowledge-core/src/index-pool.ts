/**
 * Bounded parallelism for the per-repo indexing pipeline (chunk + AST graph),
 * which is CPU-bound and was the sequential bottleneck at org scale.
 *
 * Concurrency is **adaptive, never hardcoded**: it defaults to the box's
 * available cores (scales up on bigger machines, down on smaller) and is
 * env-overridable — and it NEVER errors if fewer cores are present than hoped.
 *
 * Execution is resilient and uses **persistent workers** — each worker inits
 * tree-sitter WASM once and then processes many repos (a worker-per-repo would
 * pay that init cost N times). If a worker fails for ANY reason (spawn error,
 * WASM/init failure, crash, or a handled per-job error) the affected job falls
 * back to the main thread, so enabling parallelism can only speed an index up,
 * never break it.
 */

import os from 'node:os';
import { Worker } from 'node:worker_threads';

/**
 * Resolve the worker count.
 * - default: the box's available parallelism (NOT a fixed number) — uses what
 *   the machine actually has, going higher on big boxes and lower on small.
 * - `CODE_SEARCH_INDEX_CONCURRENCY` overrides the default when set (>0).
 * - clamped to `[1, repoCount]` (never 0, never more workers than repos).
 * - wrapped so a missing/odd `os` API never throws.
 */
export function resolveIndexConcurrency(repoCount: number): number {
  let cores = 4;
  try {
    const avail = (os as { availableParallelism?: () => number }).availableParallelism?.();
    cores = typeof avail === 'number' && avail > 0 ? avail : os.cpus().length;
  } catch {
    /* keep fallback */
  }
  if (!Number.isFinite(cores) || cores < 1) cores = 1;

  const env = parseInt(process.env.CODE_SEARCH_INDEX_CONCURRENCY ?? '', 10);
  const desired = Number.isFinite(env) && env > 0 ? env : cores; // default = available cores
  const repos = Number.isFinite(repoCount) && repoCount > 0 ? repoCount : 1;
  return Math.max(1, Math.min(desired, repos));
}

export interface RepoPoolOpts<J, R> {
  concurrency: number;
  /** Worker entry URL (dist/index-worker.js). `null` → always run in-thread. */
  workerUrl: URL | null;
  /** Run one job in the main thread — the fallback AND the no-worker path. */
  inThread: (job: J) => Promise<R>;
  /** Per-job payload posted to the worker (must be structured-cloneable). */
  toMessage: (job: J) => unknown;
  /** Called as each job completes (any order) — e.g. merge into the graph. */
  onResult?: (result: R, job: J, viaWorker: boolean) => void;
  log?: (m: string) => void;
}

type WorkerReply<R> = { ok: true; result: R } | { ok: false; error: string };

/**
 * Run `jobs` through up to `concurrency` persistent worker lanes, falling back
 * to in-thread on any worker failure. Results are returned in input order.
 * Never rejects on a worker failing — only if the in-thread fallback throws.
 */
export async function runReposPooled<J, R>(jobs: J[], opts: RepoPoolOpts<J, R>): Promise<R[]> {
  const { concurrency, workerUrl, inThread, toMessage, onResult, log } = opts;
  const results = new Array<R>(jobs.length);
  if (jobs.length === 0) return results;

  let cursor = 0;
  const nextIndex = (): number => (cursor < jobs.length ? cursor++ : -1);

  // Send one job to a worker and await exactly that job's reply (or a crash).
  const askWorker = (worker: Worker, idx: number): Promise<WorkerReply<R> | { crashed: Error }> =>
    new Promise((resolve) => {
      const onMsg = (m: WorkerReply<R>) => { cleanup(); resolve(m); };
      const onErr = (e: Error) => { cleanup(); resolve({ crashed: e }); };
      const cleanup = () => { worker.off('message', onMsg); worker.off('error', onErr); };
      worker.on('message', onMsg);
      worker.on('error', onErr);
      worker.postMessage(toMessage(jobs[idx]));
    });

  // One lane = one worker processing a stream of jobs; degrades to in-thread.
  const lane = async (): Promise<void> => {
    let worker: Worker | null = workerUrl ? trySpawn(workerUrl, log) : null;
    try {
      for (;;) {
        const idx = nextIndex();
        if (idx < 0) return;
        if (!worker) {
          results[idx] = await inThread(jobs[idx]);
          onResult?.(results[idx], jobs[idx], false);
          continue;
        }
        const reply = await askWorker(worker, idx);
        if ('ok' in reply && reply.ok) {
          results[idx] = reply.result;
          onResult?.(results[idx], jobs[idx], true);
        } else {
          if ('crashed' in reply) {
            log?.(`[index-pool] worker crashed (${reply.crashed.message}); lane continues in main thread`);
            try { await worker.terminate(); } catch { /* ignore */ }
            worker = null; // remaining jobs in this lane run in-thread
          } else {
            log?.(`[index-pool] worker reported error (${(reply as { error: string }).error}); job retried in main thread`);
          }
          results[idx] = await inThread(jobs[idx]);
          onResult?.(results[idx], jobs[idx], false);
        }
      }
    } finally {
      if (worker) { try { await worker.terminate(); } catch { /* ignore */ } }
    }
  };

  const lanes = Math.max(1, Math.min(concurrency, jobs.length));
  await Promise.all(Array.from({ length: lanes }, () => lane()));
  return results;
}

function trySpawn(url: URL, log?: (m: string) => void): Worker | null {
  try {
    return new Worker(url);
  } catch (err) {
    log?.(`[index-pool] worker spawn failed (${(err as Error).message}); lane runs in main thread`);
    return null;
  }
}
