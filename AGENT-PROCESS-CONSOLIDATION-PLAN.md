# Plan: Consolidate on `AgentProcess` — drop `runAgent` headless entry

> **Status:** Phase 0 — ADR locked 2026-05-03. Phase 1 next.
> **Companion ADR:** [`AGENT-PROCESS-CONSOLIDATION-ADR.md`](./AGENT-PROCESS-CONSOLIDATION-ADR.md).
> **Supersedes:** [`AGENT-HARNESS-PLAN.md`](./AGENT-HARNESS-PLAN.md) — the headless `runAgent` entry it shipped is removed by this initiative.

---

## Goal

One execution primitive. `AgentProcess` becomes the only way Anvil runs an agent — for the dashboard's live pipeline, the cli's interactive runs, and external eval/CI consumers. The headless `runAgent` entry is removed.

Net outcome:
- **Dashboard gains skills** (today it has none — only `runAgent` consumed them).
- **Dashboard gains MCP for Claude paths** via `--mcp-config`.
- **CLI gains an `anvil run --task` command** (the skipped Phase 5 of the harness plan).
- **Evals call `collectTrajectory(task, workspace)`** — same Inspect-AI-shaped trajectory the old `runAgent` produced.
- **`ModelAdapter → LanguageModel` bridge work disappears.** `AgentProcess` already drives `ModelAdapter` directly.

---

## Phase 0 — ADR + plan + banner (≈ 1h)

**Touches:** docs only.

- [x] Write `AGENT-PROCESS-CONSOLIDATION-ADR.md` with §1 (pre-flight), §3 (decisions C1–C10), §4 (`SpawnConfig` delta), §5 (migration touchpoints), §7 (per-phase log).
- [x] Write `AGENT-PROCESS-CONSOLIDATION-PLAN.md` (this file).
- [x] Update `AGENT-HARNESS-PLAN.md` banner to "Superseded by AGENT-PROCESS-CONSOLIDATION-PLAN.md."
- [x] Confirm `npm -w @anvil/agent-core test` baseline passes (deferred to Phase 1 commit gate).

**Exit criteria:** ADR + plan merged. No code changes.

---

## Phase 1 — Hoist skills + MCP into `defaultAdapterFactory` (≈ 4h)

**Touches:** `packages/agent-core/src/agent/session/`.

**Files modified:**
- `agent/session/types.ts` — add `workspaceDir?: string` and `claudeMcpConfigPath?: string` to `SpawnConfig`.
- `agent/session/adapter.ts` — add `workspaceDir?: string` and `claudeMcpConfigPath?: string` to `AdapterRequest`. Propagate via `buildAdapterRequest`.
- `agent/session/default-adapter-factory.ts` — load skills + MCP when `workspaceDir` is set; resolve `mcp.json` path for Claude path.
- `agent/session/language-model-bridge.ts` — read `request.projectPrompt` + `request.allowedTools` after Phase 1 mutates them upstream (no API change).
- `agent/session/__tests__/skills-mcp-spawn.test.ts` — new (≈ 5 cases).

**Implementation sketch (high-level):**

```ts
// default-adapter-factory.ts
export function defaultAdapterFactory(req: AdapterRequest): AgentAdapter {
  const registry = ProviderRegistry.getInstance();
  const provider = resolveProvider(req.model);
  const resolved = resolveAdapterOrFallback(registry, provider);

  // Workspace-rooted enrichment — skills + MCP discovery.
  if (req.workspaceDir) {
    const isClaude = resolved.provider === 'claude';
    if (!isClaude) {
      // Non-Claude paths: inject skill block into projectPrompt.
      const ctx = composeSkillContext(req.projectPrompt ?? '', {
        workspaceRoot: req.workspaceDir,
        allowedTools: req.allowedTools,
      });
      req = { ...req, projectPrompt: ctx.systemPrompt, allowedTools: ctx.allowedTools };
    } else {
      // Claude path: forward mcp.json path so claude-cli reads it.
      const mcpPath = findMcpConfigPath({ workspaceRoot: req.workspaceDir });
      if (mcpPath) req = { ...req, claudeMcpConfigPath: mcpPath };
    }
  }

  return new LanguageModelBridge(req, resolved.adapter, resolved.provider);
}
```

The Claude adapter already accepts user-supplied CLI args via `SpawnConfig.args`; Phase 1 forwards `claudeMcpConfigPath` to the args array via the existing `buildAdapterRequest` → spec mapping. (Verify this in code; if the path needs an explicit `--mcp-config` flag forward, do it in `claude.ts`.)

**Tests (5):**
1. Spawn with `workspaceDir` pointing to a fixture with `.claude/skills/foo/SKILL.md` (non-Claude provider) — assert the skill body lands in the assistant's `projectPrompt`.
2. Spawn with `workspaceDir` pointing to a fixture with `mcp.json` (Claude provider) — assert `claudeMcpConfigPath` is set to the resolved path.
3. Skill `allowed-tools` constraint intersects with `req.allowedTools` (skills can subtract, never expand).
4. Spawn with no `workspaceDir` — assert no skill prompt added, no MCP load attempted (back-compat).
5. Skill load on Claude provider — system prompt NOT injected (claude-cli loads skills itself).

**Exit criteria:** all five tests pass; existing 81 agent-core tests still pass; cli + dashboard builds clean.

---

## Phase 2 — `collectTrajectory` helper (≈ 3h)

**Touches:** `packages/agent-core/src/agent/session/collect-trajectory.ts` (new).

**Public surface:**

```ts
import type { AgentTask, AgentTrajectory, WorkspaceConfig } from './headless-types.js';

export async function collectTrajectory(
  task: AgentTask,
  workspace: WorkspaceConfig,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<AgentTrajectory>;
```

**Behavior:**
1. Translate `AgentTask + WorkspaceConfig → SpawnConfig` via private `taskToSpawnConfig`.
2. Construct `AgentProcess` directly (bypasses `AgentManager` — no checkpoint hook, no cost ledger; trajectories are self-contained).
3. Attach `content`, `activity`, `result`, `error-output`, `exit` listeners *before* `proc.start()`.
4. Accumulate the Inspect-AI trajectory:
   - `messages`: each `content` chunk appends to the current assistant message; each `activity.kind === 'tool_use'` flushes assistant turn, pushes a `tool` message stub.
   - `toolCalls`: one entry per `activity.kind === 'tool_use'`, completed when matching tool result arrives.
   - `usage` + `costUsd`: from the `result` event's `CostInfo`.
   - `finalAnswer`: `result.result`.
5. Resolve on `exit` (or `result`, whichever ships final state).
6. Honor `opts.signal` — call `proc.kill()` on abort, resolve with `finishReason: 'error'`, `error: 'aborted'`.
7. Honor `opts.timeoutMs` (default 600_000).

**Tests (6):** happy path; tool-use loop; usage aggregation; finishReason mapping; timeout; listener-ordering regression.

**Exit criteria:** trajectory shape compatible with old `runAgent`'s output for the same scripted inputs.

---

## Phase 3 — CLI `anvil run --task` (≈ 2h)

**Touches:** `packages/cli/src/commands/run.ts` (new), `packages/cli/src/index.ts`.

**Surface:**

```sh
anvil run --task "fix the failing test" \
  --model claude-sonnet-4-6 \
  [--json] [--workspace .] [--timeout 600s]
```

- **Streaming mode (default):** spawn `AgentProcess`, pipe `content` to stdout, `activity` to stderr.
- **JSON mode (`--json`):** call `collectTrajectory(...)`, write the trajectory as one JSON object.

**Tests (3):** streaming output; JSON parse; timeout exit code.

**Exit criteria:** `anvil run --task "list the top-level files"` works against this repo.

---

## Phase 4 — Dashboard `workspaceDir` wire-up (≈ 1h)

**Touches:** wherever the dashboard server calls `AgentManager.spawn(spec)`.

**Single change:** thread `workspaceDir: project.path` (or equivalent) into `SpawnConfig`. Phase 1 made the rest automatic.

**Tests (manual):**
1. Drop a `.claude/skills/test/SKILL.md` into a dashboard project; spawn an agent; confirm skill instructions activate.
2. Drop an `mcp.json` referencing a known stdio server (only if the project uses Claude); confirm tools surface.

**Exit criteria:** existing dashboard tests still green; manual smoke shows skill activation.

---

## Phase 5 — Remove `runAgent` (≈ 1h)

**Touches:** `packages/agent-core/`.

- [ ] Delete `src/headless/runner.ts`, `src/headless/index.ts`, `src/headless/__tests__/`.
- [ ] Move `src/headless/types.ts` content to `src/agent/session/headless-types.ts`; re-export from `agent/session/index.ts` and the package barrel.
- [ ] Remove `runAgent` re-export from `src/index.ts`.
- [ ] Update `packages/agent-core/README.md` "Agent harness" section.
- [ ] Update `packages/agent-core/CLAUDE.md` "Things that don't exist" section.

**Tests:** the build itself + grep.

```sh
npm -w @anvil/agent-core build
npm -w @anvil/agent-core test
npm -w @anvil/cli build
npm -w @anvil/dashboard build
grep -rn "runAgent\|@anvil/agent-core/headless" packages/  # → 0 results (sans diff.ts:307 local fn)
```

**Exit criteria:** every build green; grep clean.

---

## Phase 6 — Telemetry attributes + close-out (≈ 2h)

**Touches:** `packages/agent-core/src/telemetry/instrument.ts`, `packages/agent-core/src/agent/session/session.ts`.

- [ ] Emit `anvil.skills.activated.count` + `anvil.skills.activated.names` on `anvil.agent.session` parent span.
- [ ] Emit `anvil.mcp.servers.count` + `anvil.mcp.tools.count` on the same span.
- [ ] Emit `anvil.tool.source` (`'builtin'` or `'mcp:<server>'`) on `gen_ai.tool.<name>` child spans.

**Tests (3):** span attrs present when skills loaded; absent when not loaded; mcp source correctly tagged.

- [ ] Update ADR §7 with final commit SHAs + deviations.

**Exit criteria:** all six implementation phases shipped and the ADR's per-phase log is complete.

---

## Definition of done

- [ ] Phases 0–6 shipped, one commit each.
- [ ] `grep -rn "runAgent" packages/` returns only `packages/cli/src/commands/diff.ts:307` (unrelated local).
- [ ] `npm -w @anvil/agent-core test` — baseline (81) + new tests (~14) passing.
- [ ] `npm -w @anvil/cli test`, `npm -w @anvil/dashboard test` baselines preserved.
- [ ] Manual smoke: dashboard agent picks up a fixture skill; `anvil run --task "..." --json | jq .finalAnswer` works.

---

## Effort estimate

| Phase | Hours |
|---|---|
| 0 — ADR + plan | 1 |
| 1 — Skills+MCP into spawn path | 4 |
| 2 — `collectTrajectory` | 3 |
| 3 — CLI `anvil run --task` | 2 |
| 4 — Dashboard wire-up | 1 |
| 5 — Remove `runAgent` | 1 |
| 6 — Telemetry + close-out | 2 |
| **Total** | **~14h** |
