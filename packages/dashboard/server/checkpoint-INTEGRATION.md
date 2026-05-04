# Checkpoint Cache — Integration Notes (Phase 9)

Phase 9 introduced the deterministic checkpoint primitives
(`checkpoint-types.ts`, `checkpoint-key.ts`, `checkpoint-blob-store.ts`,
`checkpoint-store.ts`, `agent-runner-wrapper.ts`) behind a build-cache
boundary. They are standalone — nothing in `agent-manager.ts`,
`pipeline-runner.ts`, or `dashboard-server.ts` is modified. This file
lists exactly what the integration step needs to wire in.

## 1. Instantiate the stores at boot

In `dashboard-server.ts`, alongside the other stores:

```ts
import { BlobStore } from './checkpoint-blob-store.js';
import { CheckpointStore } from './checkpoint-store.js';

const blobStore = new BlobStore(ANVIL_HOME);
const checkpointStore = new CheckpointStore({ anvilHome: ANVIL_HOME, blobStore });
```

Pass both through the existing `deps` object so `pipeline-runner.ts` can
reach them without import cycles.

## 2. Wrap every agent call

Each persona invocation becomes:

```ts
import { runWithCheckpoint } from './agent-runner-wrapper.js';

const plan = await runWithCheckpoint(checkpointStore, blobStore, {
  project,
  runFamily,
  inputs: {
    stage: 'plan',
    taskId: 'plan:root',
    promptVersion: PLANNER_PROMPT_VERSION,
    model: resolvedModel,
    toolVersions: { tsc: tscVersion, 'code-search-mcp': mcpVersion },
    inputs: { feature, scope, conventions },
  },
  run: () => plannerAgent.generate(...),
  serialize: (p) => JSON.stringify(p),
  deserialize: (b) => JSON.parse(b.toString('utf-8')) as Plan,
  onHit: (rec) => broadcast({ type: 'checkpoint-hit', payload: { rec } }),
  onMiss: () => broadcast({ type: 'checkpoint-miss', payload: { stage: 'plan' } }),
});
```

Wrap:
- **planner** — one checkpoint per feature/run.
- **implement** — one per changed file (`taskId: 'impl:<file>'`).
- **review personas** — one per persona (`taskId: 'review:<persona>'`).
- **test authors** — one per symbol (`taskId: 'test:<file>::<symbol>'`).
- **mutation runner** — one per mutation batch.
- **kb-grounding** — one per query (`taskId: 'kb:<queryHash>'`).

## 3. Stable `runFamily`

A `runFamily` is preserved across retries of the same logical run. We
recommend:

1. When the user kicks off a pipeline, generate a `runId` (UUID).
2. Store it as `restartGroup` on the run record.
3. Use that same id as `runFamily` on every subsequent resume / retry.

If a user explicitly forces a fresh run (e.g. `anvil plan generate --no-cache`),
the integration should rotate the `runFamily` to a new id, which guarantees
cache-misses for every agent.

## 4. Cost-reject / user-cancel → SIGTERM ordering

The Phase 8 cost-reject flow fires `SIGTERM` to the dashboard subprocess when
a run exceeds budget. With the wrapper in place, ordering is:

1. Cost sentinel emits `SIGTERM` (via `process.kill(pid, 'SIGTERM')`).
2. Every `runWithCheckpoint` currently in-flight runs its handler. Each
   writes its record as `status: 'interrupted'` with
   `errorMessage: 'signal:SIGTERM'` and flushes atomically via tmp+rename.
3. Control returns to whatever awaited the agent promise; the agent either
   resolves (wrapper returns output but keeps the `interrupted` record for
   diagnostics) or rejects (wrapper rethrows without overwriting the
   interrupted status).
4. `pipeline-runner.ts` already owns the top-level SIGTERM handler that
   aborts the pipeline. It runs alongside — not replacing — the wrapper
   handlers, because the wrapper uses `process.on` (not `process.once`)
   and removes only its own closures.

This means a resumed run's `CheckpointStore.listForRun` can identify
exactly which task was in-flight at cancel time and surface it.

## 5. CLI command registration

In `packages/cli/src/commands/index-cmd.ts` (or wherever top-level
commands are wired):

```ts
import { checkpointsCommand } from './checkpoints.js';
program.addCommand(checkpointsCommand);
```

Users can then run:

- `anvil-loc checkpoints stats --project demo`
- `anvil-loc checkpoints invalidate --run run-42 --stage review`
- `anvil-loc checkpoints gc --older-than 30d`
