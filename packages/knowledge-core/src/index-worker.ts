/**
 * Persistent worker entry for the per-repo indexing pipeline. The pool
 * (index-pool.ts) spawns one of these per lane; it stays alive and processes a
 * stream of repo jobs, so tree-sitter WASM initializes once per worker, not per
 * repo. Imports only repo-pipeline.ts (no LanceDB / agent-core) to stay lean.
 */

import { parentPort } from 'node:worker_threads';
import { processRepoPipeline, type RepoJob } from './repo-pipeline.js';

if (parentPort) {
  const port = parentPort;
  port.on('message', async (job: RepoJob) => {
    try {
      const result = await processRepoPipeline(job);
      port.postMessage({ ok: true, result });
    } catch (err) {
      port.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  });
}
