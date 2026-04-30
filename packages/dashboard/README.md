# @anvil-dev/dashboard

Real-time pipeline orchestration UI + Node.js server for Anvil — React frontend, WebSocket backend, knowledge graph visualization, and agent management.

---

## Architecture

The dashboard is a **consumer** of four extracted Anvil packages
(see `DASHBOARD-CONSOLIDATION-ADR.md` for the full decision record):

| Package | Used for |
|---|---|
| `@anvil/agent-core` | Provider adapters + agent lifecycle (`AgentManager` / `AgentProcess`) + per-call checkpoint cache (`runWithCheckpoint`, `CheckpointStore`, `BlobStore`). Dashboard imports `AgentManager` directly from agent-core — no local re-exports. |
| `@anvil/core-pipeline` | `EventBus` + `Step<I,O>` + `StepRegistry` + `Pipeline` — dashboard's `pipeline-runner.ts` orchestrates Steps from `server/steps/` |
| `@anvil/knowledge-core` | Codebase fingerprinting, structural-hash diffing, KB-tier prompt injection |
| `@anvil/memory-core` | `HybridMemoryStore` (JSONL canonical + SQLite hot index) — dashboard's `memory-store.ts` is now a thin façade over this |

`packages/cli` and the dashboard share these packages — the same Step factories that lift `pipeline-runner.ts` features (per-repo fanout, per-task build, clarify Q&A, fix-loop, post-build guards, prompt builders) are usable from cli too. As of the agent-manager consolidation, `cli/src/commands/diff.ts` also consumes `runWithCheckpoint` so re-runs against the same git state hit the per-call cache (see `AGENT-MANAGER-CONSOLIDATION-ADR.md`).

---

## Local development

```bash
# from repo root
npm install
npm -w @anvil-dev/dashboard run build
node packages/dashboard/server/dashboard-server.js   # starts WS on :7475 by default

# vite dev server (frontend)
npm -w @anvil-dev/dashboard run dev                  # http://localhost:5173
```

### Tests

```bash
npm -w @anvil-dev/dashboard run test:server
# Compiles server/tsconfig.json then runs node --test on every
# server/out/__tests__/*.test.js. There are 6 pre-existing failures
# (project-loader.getModelForStage, applyConventionFilter ×3,
# review-evidence-gate.precedent) tracked in the IDE-Jest false-positive
# memory note — trust the node --test exit code, not the IDE markers.
```

---

## Storage layout

The dashboard writes to `~/.anvil/` (or `$ANVIL_HOME`):

```
~/.anvil/
├── adapters/                   # Provider adapter configs (factory.yaml refs)
├── checkpoints/                # PipelineRunner checkpoints (resume support)
├── memories/
│   ├── v2/
│   │   ├── memories.jsonl      # Canonical append-only (memory-core)
│   │   └── index.sqlite        # Hot index (BM25 / namespace queries)
│   └── _archive_<ts>/          # Migrated legacy MEMORY.md / USER.md (one-shot)
├── projects/                   # Per-project workspace + factory.yaml
├── runs/                       # Per-run audit logs (audit.jsonl, costs)
└── spend/                      # SpendLedger SQLite (agent-core)
```

### Memory migration (Phase 5, D6)

Existing `~/.anvil/memories/<project>/{MEMORY.md,USER.md}` files are migrated **once** on first read/write per project:

1. Each delimiter-separated entry is parsed (with `<!-- added:<iso> -->` timestamp headers preserved verbatim).
2. Entries land in `~/.anvil/memories/v2/memories.jsonl` as `Memory` records:
   - `target='memory'` → `kind='semantic'` `subtype='manual'` namespace `{scope:'project',projectId}`
   - `target='user'` → `kind='profile'` namespace `{scope:'user',projectId}`
3. The project directory is then moved under `~/.anvil/memories/_archive_<ts>/<project>/`.

The dashboard's WebSocket API (`memory:add` / `memory:replace` / `memory:remove`) keeps the same payload shapes (D10) — only the storage backend changed. The 5 ops (`add`, `replace`, `remove`, `getEntriesWithMeta`, `formatForPrompt`) keep their legacy `MemoryActionResult` return shapes verbatim.

Char limits (4000 / 2000), substring matching for `replace`/`remove` (with multi-match detection), and dedup-on-add are dashboard-specific UX rules that stay in the `MemoryStore` façade — `memory-core` stays generic.

---

## Cost ledger bridge (Phase 3, D4)

Dashboard's `CostLedger` (NDJSON, per-run + daily-rollup) and `agent-core`'s `SpendLedger` (SQLite, queryable + indexed) **stay separate**. A `BridgedCostLedger` mirrors `record()` calls into `SpendLedger` so both readers see all writes. Storage merge is out of scope.

Provider inference (since `CostEntry` doesn't carry a provider field):

| Model id prefix | Provider |
|---|---|
| `claude-` | `anthropic` |
| `gpt-`, `o[134]` | `openai` |
| `gemini-` | `google` |
| `llama`, `mistral`, `qwen`, `phi` | `ollama` |

Other ids fall back to `unknown`.

---

## Pipeline runner shape (Phase 4)

`server/pipeline-runner.ts` is the dashboard's per-run orchestrator. After the Phase 4 series, it delegates **every** spawn-and-wait, prompt build, and shell-side operation to a Step factory or pure helper under `server/steps/`:

| Module | Responsibility |
|---|---|
| `agent-spawner.ts` | `spawnAndWait` / `waitForAgent` |
| `per-repo-stage.step.ts` | Per-repo Step + `runPerRepoStageForRepo` |
| `per-repo-build.step.ts` | Per-task fanout for the build stage |
| `clarify-stage.step.ts` | Explore + Q&A + synthesize compose |
| `clarify.step.ts` | Q&A loop in isolation (`createClarifyStep`) |
| `feature-manifest.step.ts` | `FEATURE-MANIFEST.json` extraction |
| `plan-risk.step.ts` | `PLAN-RISK.json` scorer |
| `task-bundler.step.ts` | `TASK-BUNDLES.json` generator |
| `test-gen-stage.step.ts` | Deterministic test-spec generator |
| `fix-loop.step.ts` | Validate-failure → engineer-fix loop |
| `workspace-ops.ts` | `pullBaseBranchForRepos` / `runPostBuildGuards` / `deployProject` / `createFeatureBranches` |
| `prompt-builders.ts` | All system + user prompt builders |
| `cost-budget.hook.ts` | Per-step cost-budget enforcement |
| `build-registry.ts` | `buildDashboardStepRegistry` for Pipeline.run wiring |

`pipeline-runner.ts` keeps the dashboard-specific orchestration shell: cache management for project-prompt invariants (P1), the resume-aware iteration loop, after-stage hooks, `broadcastState` over WebSocket, and the WebSocket event vocabulary (D10 — 133 messages unchanged).

The original "≤300 LOC façade" target requires `Pipeline.run()` checkpoint/resume support that doesn't exist in `core-pipeline` yet — see ADR §6 row 4f.7 for the full discussion.

---

## See also

- [`DASHBOARD-CONSOLIDATION-ADR.md`](../../DASHBOARD-CONSOLIDATION-ADR.md) — full decision record + per-phase implementation log with commit hashes
- [`DASHBOARD-CONSOLIDATION-PLAN.md`](../../DASHBOARD-CONSOLIDATION-PLAN.md) — the original 6-phase plan
- [`MEMORY-CORE-ADR.md`](../../MEMORY-CORE-ADR.md) — memory-core's own architecture doc
