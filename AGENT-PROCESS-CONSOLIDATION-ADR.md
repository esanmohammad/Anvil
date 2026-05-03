# Agent Process Consolidation — Architecture Decision Record

> Companion to [`AGENT-PROCESS-CONSOLIDATION-PLAN.md`](./AGENT-PROCESS-CONSOLIDATION-PLAN.md). Locks the decisions, schemas, and migration strategy the executable plan refers to.
>
> **Status:** Phase 0 — locked 2026-05-03.
> **Supersedes:** [`AGENT-HARNESS-PLAN.md`](./AGENT-HARNESS-PLAN.md) (the headless `runAgent` entry it shipped is removed by this initiative).
> **Depends on:** `AGENT-MANAGER-CONSOLIDATION-ADR.md` (shipped — established `AgentProcess`/`AgentManager` as canonical).

---

## 1. Pre-flight reality check (verified 2026-05-03)

| Check | Result |
|---|---|
| `packages/agent-core/src/agent/session/` exists | ✅ |
| `packages/agent-core/src/headless/` exists (to be removed) | ✅ |
| `packages/agent-core/src/skills/` ships `composeSkillContext` | ✅ |
| `packages/agent-core/src/mcp/` ships `loadMcpServers` + `buildAgentToolset` | ✅ |
| `runAgent` has zero in-tree callers (only its own re-exports + tests) | ✅ — verified via `grep -rln "from '@anvil/agent-core/headless'" packages/` |
| `cli/src/commands/diff.ts:307` references a same-named local function unrelated to the headless entry | ✅ |
| `AgentProcess` event surface (5 events: `content`/`activity`/`result`/`error-output`/`exit`) is stable | ✅ |
| `defaultAdapterFactory` is the single resolution seam used by `AgentManager` | ✅ |

No reconciliation needed.

---

## 2. Why consolidate

The Agent Harness initiative (shipped 2026-04-29) added a parallel execution surface — `runAgent(task, workspace) → AgentTrajectory` — alongside the existing `AgentProcess` lifecycle. The two paths solve different problems:

- **`AgentProcess`** — streaming, EventEmitter-based, supports resume + interactive kill. Drives the dashboard live pipeline UI and the cli's interactive runs.
- **`runAgent`** — request→trajectory, Inspect-AI-shaped, designed for external eval frameworks.

Maintaining both has costs:
1. **Skills + MCP load only on the `runAgent` path.** The dashboard and cli — the everyday consumers — do not see them. Users authoring `.claude/skills/` for their workspace get nothing in the UI today.
2. **`runAgent` requires a `LanguageModel` impl** that no agent-core adapter natively provides (per observability ADR §3.4). Shipping the bridge to make `runAgent` callable from production is a non-trivial follow-up.
3. **Two execution loops to maintain** — when the tool-call iteration cap, timeout semantics, or telemetry attributes change, both must update in lockstep.

The consolidation collapses these onto `AgentProcess` and replaces `runAgent` with `collectTrajectory(task, workspace) → AgentTrajectory` — a thin event aggregator over a real `AgentProcess` run.

---

## 3. Decisions

### C1 — `runAgent` replacement for evals

**Choice:** **`collectTrajectory(task, workspace, opts?) → Promise<AgentTrajectory>`** in `packages/agent-core/src/agent/session/collect-trajectory.ts`.

**Why:** External consumers (Inspect AI, SWE-bench, custom benchmark scripts) want a Promise<Trajectory>. `collectTrajectory` owns the `AgentProcess` lifecycle (construct → listen → start → resolve on `exit`/`result`). ~80–120 LOC. Same trajectory shape `runAgent` produced.

### C2 — Trajectory shape

**Choice:** **Unchanged.** `AgentTrajectory`, `TrajectoryMessage`, `TrajectoryToolCall`, `TrajectoryUsage`, `AgentTask`, `WorkspaceConfig` keep their existing fields. They move from `src/headless/types.ts` to `src/agent/session/headless-types.ts`.

**Why:** Inspect-AI compatibility is the whole point of the trajectory shape. External consumers shouldn't see a contract change — only the entrypoint name changes.

### C3 — Where skills + MCP load

**Choice:** **`defaultAdapterFactory`** (`src/agent/session/default-adapter-factory.ts`) — the single seam every `AgentManager.spawn()` and direct `AgentProcess` flows through.

**Why:** Putting it anywhere else (e.g. inside `LanguageModelBridge` or in callers) means the dashboard, cli, and `collectTrajectory` each wire it independently and drift. One seam = one bug fix when something goes wrong.

### C4 — New `SpawnConfig` field for skills/MCP discovery

**Choice:** **`workspaceDir?: string`** on `SpawnConfig` and `AdapterRequest`. Optional. `buildAdapterRequest` propagates it.

**Why:** Skills + MCP are workspace-rooted. Reusing `cwd` would conflate "subprocess working directory" with "where to read `.claude/skills/`" — not the same in tests, and not the same in cli runs that operate on a sub-folder of the workspace.

### C5 — Claude vs non-Claude tool routing

**Choice:**
- **Claude path**: pass `--mcp-config <path>` via the existing CLI args mechanism. Claude CLI auto-loads `.claude/skills/` itself, so agent-core does NOT inject the skill system prompt for the Claude path.
- **Non-Claude path**: agent-core injects `composeSkillContext` output into `projectPrompt`. MCP tool merging into the bridge's executor is **deferred to a follow-up** (see §6) — too invasive for this consolidation, and the dashboard's day-one win is skills, not MCP-on-Ollama.

**Why:** Avoid double-loading on Claude. Ship the small win (skills everywhere, Claude MCP everywhere) without bundling the bigger executor refactor that MCP-on-non-Claude requires.

### C6 — Deprecation of `runAgent`

**Choice:** **Remove the `src/headless/` directory** in the same release. Type names re-export from `agent/session/headless-types.ts` so external imports of types (not the function) keep working.

**Why:** Per `MEMORY.md` "no feature flags for dashboard consolidation" rule — full cutover, branch parity diff replaces gated rollout. Zero in-tree callers means nothing inside the repo breaks.

### C7 — `AgentTask` → `SpawnConfig` mapping

**Choice:** Private helper `taskToSpawnConfig(task, workspace)` inside `collect-trajectory.ts`. Maps:
- `task.prompt` → `spec.prompt`
- `task.systemPrompt` → `spec.projectPrompt`
- `task.allowedTools` → `spec.allowedTools`
- `task.model` → `spec.model`
- `task.maxTokens` → `spec.maxOutputTokens`
- `task.taskId` → `spec.runId`
- `workspace.rootDir` → `spec.cwd` AND `spec.workspaceDir`
- `workspace.env` → forwarded via the spawn options (out-of-band of `SpawnConfig`)

**Why:** Keeps the eval-facing API ergonomic (`AgentTask`/`WorkspaceConfig`) without polluting `SpawnConfig` with eval-only fields.

### C8 — Backward compatibility shim

**Choice:** **None.** `runAgent` is removed; eval consumers migrate to `collectTrajectory` in the same PR. README + CLAUDE.md updated to teach the new entry point.

**Why:** Same memory note as C6. Branch parity is the migration mechanism.

### C9 — Test placement + style

**Choice:**
- New: `agent-core/src/agent/session/__tests__/collect-trajectory.test.ts` (Phase 2, ~6 cases).
- New: `agent-core/src/agent/session/__tests__/skills-mcp-spawn.test.ts` (Phase 1, ~5 cases).
- Existing `runAgent` tests (`headless/__tests__/runner.test.ts`) deleted in Phase 5.

**Why:** Colocated with the code. `node --test` on `dist/`. Per `MEMORY.md` "IDE Jest false-positives": trust the `node --test` exit code if the IDE squiggles.

### C10 — Telemetry attributes

**Choice:** Promote ADR follow-up #5 (skills + MCP span attributes) into Phase 6 of this initiative. Specifically:
- `anvil.skills.activated.count` (number) on `anvil.agent.session` parent span when skills loaded.
- `anvil.skills.activated.names` (comma-joined string) on the same span.
- `anvil.mcp.servers.count` (number) on the same span.
- `anvil.mcp.tools.count` (number) on the same span.
- `anvil.tool.source = 'builtin' | 'mcp:<server>'` on `gen_ai.tool.<name>` child spans.

**Why:** Skills + MCP become first-class citizens of the spawn path; their telemetry surface should match.

---

## 4. `SpawnConfig` schema delta

```diff
 export interface SpawnConfig {
   name: string;
   persona: string;
   project: string;
   stage: string;
   prompt: string;
   model: string;
   cwd: string;
+  /**
+   * Workspace root for skills + MCP discovery. Distinct from `cwd` (the
+   * subprocess working directory) so tests can run with cwd === '/tmp'
+   * while loading skills from the repo root. When undefined, skills + MCP
+   * are skipped (back-compat with existing spawn sites).
+   */
+  workspaceDir?: string;
   projectPrompt?: string;
   permissionMode?: string;
   disallowedTools?: string[];
   allowedTools?: string[];
   maxOutputTokens?: number;
   runId?: string;
   runFamily?: string;
   restart?: { maxAttempts: number };
   timeoutMs?: number;
   binaryPath?: string;
   args?: string[];
+  /**
+   * Internal — populated by `defaultAdapterFactory` for the Claude CLI
+   * path so the adapter can pass `--mcp-config <path>` to claude-cli.
+   * Not user-facing.
+   */
+  claudeMcpConfigPath?: string;
 }
```

`AdapterRequest` mirrors the additions (workspace propagates through `buildAdapterRequest`).

---

## 5. Migration touchpoints

```
packages/agent-core/
├── src/
│   ├── agent/session/
│   │   ├── collect-trajectory.ts            [NEW — Phase 2]
│   │   ├── default-adapter-factory.ts       [MODIFIED — Phase 1]
│   │   ├── headless-types.ts                [NEW — Phase 5; moved from src/headless/types.ts]
│   │   ├── language-model-bridge.ts         [MODIFIED — Phase 1, additional tools]
│   │   ├── session.ts                       [MODIFIED — Phase 6 telemetry attrs]
│   │   ├── types.ts                         [MODIFIED — Phase 1, SpawnConfig delta]
│   │   ├── adapter.ts                       [MODIFIED — Phase 1, AdapterRequest delta]
│   │   ├── index.ts                         [MODIFIED — Phase 5 type re-exports]
│   │   └── __tests__/
│   │       ├── collect-trajectory.test.ts   [NEW — Phase 2]
│   │       └── skills-mcp-spawn.test.ts     [NEW — Phase 1]
│   ├── headless/                            [DELETED — Phase 5]
│   ├── index.ts                             [MODIFIED — Phase 5; drop runAgent export]
│   └── telemetry/instrument.ts              [MODIFIED — Phase 6]
├── README.md                                [MODIFIED — Phase 5 + Phase 6]
└── CLAUDE.md                                [MODIFIED — Phase 5]

packages/cli/
└── src/
    ├── commands/run.ts                      [NEW — Phase 3]
    └── index.ts                             [MODIFIED — Phase 3, register command]

packages/dashboard/
└── server/                                  [MODIFIED — Phase 4, thread workspaceDir]

(repo root)
├── AGENT-PROCESS-CONSOLIDATION-ADR.md       [NEW — Phase 0, this file]
├── AGENT-PROCESS-CONSOLIDATION-PLAN.md      [NEW — Phase 0]
└── AGENT-HARNESS-PLAN.md                    [MODIFIED — Phase 0 banner]
```

---

## 6. Out of scope / known follow-ups

1. **MCP tool merging into non-Claude bridge.** Today the bridge constructs a `BuiltinToolExecutor` for non-Claude paths. Extending it to route MCP tool calls (per the `mcpDispatch` map from `buildAgentToolset`) is its own refactor — affects `BuiltinToolExecutor`'s contract and the agentic loop in Ollama / OpenRouter / OpenCode. Punted to a follow-up. The Claude path gets MCP day-one via `--mcp-config`.
2. **`runAgent` external consumers.** None known in the repo. If external eval recipes referenced it, they migrate to `collectTrajectory` (one-line change). The README rewrite in Phase 5 documents the new entry.
3. **Per-stage skill scoping.** Today all activated skills load on every spawn. If stages should activate disjoint skill sets, that's a future concern handled by `applyToolPolicy` extensions.
4. **`mcpServerTimeout` config.** If MCP server boot latency becomes a problem, add a `mcpServerTimeout` (default 5s) and skip slow servers with a warning. Not needed day-one.

---

## 7. Per-phase commit log

Filled in as each phase ships. See `AGENT-PROCESS-CONSOLIDATION-PLAN.md` for the phase definitions.

| Phase | Status | Commit | Deviations |
|---|---|---|---|
| 0 — ADR + plan + banner | 🚧 in flight | — | — |
| 1 — Skills + MCP into spawn path | ⏳ pending | — | — |
| 2 — `collectTrajectory` | ⏳ pending | — | — |
| 3 — CLI `anvil run --task` | ⏳ pending | — | — |
| 4 — Dashboard `workspaceDir` wire-up | ⏳ pending | — | — |
| 5 — Remove `runAgent` | ⏳ pending | — | — |
| 6 — Telemetry attrs + close-out | ⏳ pending | — | — |
