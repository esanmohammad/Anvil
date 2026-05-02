# Comprehensive Follow-Up Plan: Loading States + Fix Flow

Two tracks. Self-contained so this can execute cold after a context
compaction. Branch: `feat/plan-generation` (do not push without
explicit user approval).

## Context recap

Already shipped on this branch (post-compaction Tasks A–E):

- D — vendor Geist + Geist Mono variable woff2 (cbb5578)
- A — reflection on by default + memory-config UI badge (48e9764)
- B — drop legacy memory formatter + envelope-disable hatch (8aa6c88)
- E — sleeptime auto-promotes ratified fix-pattern memories to
      convention rules (8a1eeb6)
- C — terminal-forge palette sweep across 17 components (d16a6ad)

Open items the user flagged from the latest screenshots:

1. The Fix flow's routing card lists three stages (`fix`, `fix-loop`,
   `validate`) but the dashboard's `run-fix` handler only spawns ONE
   agent — the other two rows are decorative. The user wants Fix mode
   to actually orchestrate all three.
2. Several pages render an empty/error state instantly on first paint
   instead of a loading skeleton, making the dashboard feel broken
   when the WS handshake is in flight or the dashboard server is
   slow. Settings/Providers, Memory, History, etc.

Both tracks below are independent — pick either order. Recommended: L
first (additive, low blast-radius) then F (touches the run lifecycle).

Total: ~1.5 days focused work.

---

## Track L — Comprehensive loading states

**Goal:** every page that depends on a WS payload distinguishes
*loading* from *empty*. First paint shows skeleton rows; data swap is
animated; if the WS never responds within 5 s we fall back to a
contextual empty/error message that names the underlying cause
(usually "dashboard server unreachable").

Estimate: ~1.5 hours.

### L.1 — Shared skeleton primitives (15 min)

Create `packages/dashboard/src/components/common/Skeleton.tsx`:

```tsx
import React from 'react';

export interface SkeletonProps {
  width?: number | string;
  height?: number;
  radius?: string;          // CSS var name; defaults to --radius-xs
  className?: string;
  style?: React.CSSProperties;
}

export function Skeleton({ width = '100%', height = 14, radius, style }: SkeletonProps) {
  return (
    <div
      aria-hidden="true"
      style={{
        width, height,
        background: 'var(--bg-elevated-3)',
        borderRadius: `var(${radius ?? '--radius-xs'})`,
        animation: 'shimmer 1.5s ease-in-out infinite',
        backgroundSize: '200% 100%',
        backgroundImage:
          'linear-gradient(90deg, var(--bg-elevated-2) 25%, var(--bg-elevated-3) 50%, var(--bg-elevated-2) 75%)',
        ...style,
      }}
    />
  );
}

export function RowSkeleton({ count = 3, height = 32, gap = 6 }: { count?: number; height?: number; gap?: number }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap }}>
      {Array.from({ length: count }, (_, i) => (
        <Skeleton key={i} height={height} radius="--radius-sm" />
      ))}
    </div>
  );
}

export function CardSkeleton({ lines = 2 }: { lines?: number }) {
  return (
    <div style={{
      padding: 'var(--space-md)',
      background: 'var(--bg-elevated-2)',
      border: '1px solid var(--separator)',
      borderRadius: 'var(--radius-md)',
      display: 'flex', flexDirection: 'column', gap: 8,
    }}>
      {Array.from({ length: lines }, (_, i) => (
        <Skeleton key={i} height={i === 0 ? 16 : 12} width={i === 0 ? '60%' : '90%'} />
      ))}
    </div>
  );
}

export function TileSkeleton() {
  return (
    <div style={{
      padding: 12,
      background: 'var(--bg-elevated-2)',
      border: '1px solid var(--separator)',
      borderRadius: 'var(--radius-sm)',
      display: 'flex', flexDirection: 'column', gap: 6,
      minHeight: 64,
    }}>
      <Skeleton height={11} width="40%" />
      <Skeleton height={20} width="55%" />
    </div>
  );
}
```

Add a custom hook `useLoadingState` in the same file:

```tsx
export interface LoadingState {
  loading: boolean;
  error: string | null;
  loaded: () => void;
  errored: (msg: string) => void;
}

export function useLoadingState(timeoutMs = 5000): LoadingState {
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);
  const timer = React.useRef<number | null>(null);

  React.useEffect(() => {
    timer.current = window.setTimeout(() => {
      // If still loading after timeout, attribute to server unreachable
      setLoading((isLoading) => {
        if (isLoading) setError('Dashboard server unreachable — check that anvil-loc dashboard is running.');
        return false;
      });
    }, timeoutMs);
    return () => { if (timer.current) window.clearTimeout(timer.current); };
  }, [timeoutMs]);

  return {
    loading,
    error,
    loaded: () => { setLoading(false); setError(null); if (timer.current) window.clearTimeout(timer.current); },
    errored: (msg: string) => { setLoading(false); setError(msg); if (timer.current) window.clearTimeout(timer.current); },
  };
}
```

### L.2 — Per-page wiring (60 min total)

For each page below, the pattern is:

1. Add `const { loading, error, loaded, errored } = useLoadingState();`
2. On WS message that delivers the page's payload → call `loaded()`.
3. On WS error message that targets the page's domain → call `errored(msg)`.
4. Render `<RowSkeleton />` (or `<CardSkeleton />` / `<TileSkeleton />`)
   when `loading === true`. Render the existing empty state ONLY when
   `loading === false && (data is empty)`.
5. Render an error banner with the actionable message when `error`.

#### L.2.1 Settings / Providers (`SettingsPage.tsx`) — 8 min

- The "No providers detected. Make sure the dashboard server is running."
  message currently fires on first paint because `providers === []` is
  the initial state. Wrong — it should be "loading" until either
  `discover-providers` payload arrives OR 5 s timeout elapses.
- Hook into the existing WS handler that sets `providers`. On `loaded()`,
  show the actual providers (or a real "no providers configured"
  message if the response was an empty array).
- Skeletons: 4 rows of `<TileSkeleton />` arranged in a 2-column grid,
  matching the future layout of provider cards.

#### L.2.2 Memory (`MemoryPage.tsx`) — 5 min

- `payload === null` is currently the implicit loading state, but the
  page renders nothing in that case. Replace with `<RowSkeleton count={6} height={48} />`.
- Memory-config badge stays as-is; it's already gated on `config !== null`.

#### L.2.3 History (`HistoryPage.tsx` / `RunRow.tsx`) — 8 min

- Run list renders empty during the initial WS handshake. Add a
  `<RowSkeleton count={8} height={56} />` block that swaps for the
  actual rows once `runs` is populated.
- The page header (filters, run count) can show `<Skeleton width={120} height={14} />`
  in place of the count.

#### L.2.4 PR Board (`PRBoardPage.tsx` / `PRCard.tsx`) — 6 min

- Card grid renders empty until `prs` arrives. Add 6 `<CardSkeleton />`
  cards in the same grid layout while loading.

#### L.2.5 Active Runs (sidebar tile + `ActiveRunsPage.tsx`) — 6 min

- The sidebar "Active Runs" pill currently shows `0` while loading.
  Show `<Skeleton width={20} height={11} />` until first WS payload.
- Page itself: `<CardSkeleton />` × 3 while loading.

#### L.2.6 Plan list (`PlanPage.tsx` / plan grid) — 6 min

- Plan cards on the home page's CONTINUE / RECENT sections render
  empty while loading. Add `<RowSkeleton count={3} height={40} />` for
  CONTINUE and the same for RECENT.

#### L.2.7 Review queue (`ReviewPage.tsx`) — 6 min

- Findings list renders empty during load. `<RowSkeleton count={5} height={64} />`.

#### L.2.8 Insights (`InsightsPage.tsx`) — 6 min

- Charts render at zero values during load. Replace each chart container
  with `<Skeleton height={180} radius="--radius-md" />` while waiting
  for the metrics payload.

#### L.2.9 Stats (`StatsPage.tsx`) — 5 min

- Tile grid: `<TileSkeleton />` × 8 while loading.

#### L.2.10 Knowledge Graph (`KnowledgeGraphPage.tsx`) — 4 min

- The ForceGraph canvas takes ~2 s to lay out on a fresh project.
  Show `<Skeleton height={500} radius="--radius-md" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>Building graph…</Skeleton>`
  pre-paint. (Wrap the children in a centered span; Skeleton accepts
  `style` so this is a one-line addition.)

### L.3 — Validation (15 min)

- Throttle the Network panel to "Slow 3G" in DevTools. Walk every page.
- For each page: confirm skeleton appears within 16 ms of route change,
  swaps in real data on WS payload, and falls back to a labelled
  empty/error state if no payload arrives.
- Build clean: `npm -w @anvil-dev/dashboard run build`.
- Rebuild cli to bundle: `npm -w @esankhan3/anvil-cli run build`.

### Watch-outs

- `useLoadingState` MUST clear its timeout in cleanup or you'll leak
  setTimeout handles across route changes.
- Don't wrap WS handlers in the hook — they should call `loaded()`
  imperatively from the existing `addEventListener('message')` flow.
- Avoid double-skeletons: if a page already shows a `<RowSkeleton>`
  in `RoutingCard` (for example), don't add a second one wrapping
  the whole page.
- The `shimmer` keyframe is already defined in `index.css` from prior
  work — do not redeclare.

---

## Track F — Fix flow becomes a real pipeline

**Goal:** when the user submits a Fix, the dashboard runs
`fix → validate → fix-loop` (with attempt cap) per repo, broadcasts
three-stage progress over WS, and persists the run for memory hygiene
(reflection + recordPrEpisode).

Estimate: ~3.5 hours.

### F.1 — Step factory: extract `runValidate` (30 min)

Today the validate step lives inside the build pipeline as a per-repo
stage. The Fix flow needs a standalone validate step it can compose.

1. Create `packages/dashboard/server/steps/validate.step.ts`.
2. Lift the per-repo validate body from `pipeline-runner.ts:runValidate`
   (or wherever the validate spawn lives) into a `Step<ValidateInput,
   ValidateOutput>` factory.
3. ValidateInput: `{ project: string; repoNames: string[]; repoPaths: Record<string, string>; workspaceDir: string }`.
4. ValidateOutput: `{ artifact: string; failed: boolean; perRepo: Record<string, { failed: boolean; section: string }> }`.
5. Reuse `hasValidationFailures` + `extractRepoSection` from `fix-loop.step.ts`.
6. Implementation:
   - For each repo (or single workspace): spawn a validator agent with
     `stage: 'validate'`, `persona: 'tester'`, prompt = "Run lint, typecheck,
     and tests; report PASS/FAIL per check".
   - Combine outputs into a single VALIDATE.md artifact stored in
     feature-store at `~/.anvil/runs/<runId>/VALIDATE.md`.
   - Determine `failed` via `hasValidationFailures(artifact)`.
7. Use `runStageWithFallback('validate', …)` for tier walking.

### F.2 — Step factory: `runFix` (30 min)

The "fix" step is what we have today as a one-shot agent in
`dashboard-server.ts:5802`. Wrap it in a Step factory:

1. Create `packages/dashboard/server/steps/fix.step.ts`.
2. FixInput: `{ project: string; description: string; repoPaths: Record<string, string>; workspaceDir: string; model?: string }`.
3. FixOutput: `{ agentId: string; diffSummary?: string }`.
4. Implementation:
   - Per-repo fan-out (parallelism: 'per-repo') if `repoNames.length > 0`,
     else single-workspace path.
   - Spawn engineer-persona agent with the bug description as the prompt
     plus the repo's prompt envelope (memory + conventions block).
   - `disallowedTools = ['Agent']` (matches engineer rule).
5. Returns the agent id so fix-loop can resume it on retry (existing
   `priorByRepo` / `priorSingleId` machinery).

### F.3 — Fix-flow registry + orchestrator (45 min)

Create `packages/dashboard/server/steps/fix-flow-registry.ts`:

```ts
import { StepRegistry, Pipeline } from '@anvil/core-pipeline';
import { runFix } from './fix.step.js';
import { runValidate } from './validate.step.js';
import { runFixLoop, hasValidationFailures } from './fix-loop.step.js';

export interface FixFlowConfig {
  project: string;
  description: string;
  workspaceDir: string;
  repoNames: string[];
  repoPaths: Record<string, string>;
  model?: string;
  maxFixAttempts?: number;       // default 3
}

export function buildFixFlowRegistry(deps: {
  agentManager: AgentManager;
  emit: (event: string, payload: unknown) => void;
}): StepRegistry {
  const reg = new StepRegistry();

  reg.register({
    id: 'fix',
    parallelism: 'per-repo',
    run: async (ctx) => {
      const result = await runFix({
        agentManager: deps.agentManager,
        ...ctx.input,
      });
      ctx.emit('fix-output', result);
      return result;
    },
  });

  reg.register({
    id: 'validate',
    parallelism: 'per-repo',
    run: async (ctx) => {
      const result = await runValidate({
        agentManager: deps.agentManager,
        ...ctx.input,
      });
      ctx.emit('validate-output', result);
      return result;
    },
  });

  reg.register({
    id: 'fix-loop',
    run: async (ctx) => {
      const validateOut = ctx.artifacts.get('validate-output') as ValidateOutput;
      if (!validateOut.failed) return { skipped: true };

      const maxAttempts = ctx.input.maxFixAttempts ?? 3;
      let lastValidate = validateOut;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        const fixResult = await runFixLoop({
          agentManager: deps.agentManager,
          validateArtifact: lastValidate.artifact,
          attempt,
          ...ctx.input,
        });

        // Re-validate after fix-loop attempt
        lastValidate = await runValidate({
          agentManager: deps.agentManager,
          ...ctx.input,
        });

        if (!lastValidate.failed) {
          return { ratified: true, attempts: attempt };
        }
      }

      throw new Error(`fix-loop exhausted after ${maxAttempts} attempts`);
    },
  });

  return reg;
}
```

### F.4 — Wire dashboard `run-fix` handler (45 min)

In `dashboard-server.ts` around line 5802, replace the single-agent
spawn with a Pipeline construction:

```ts
case 'run-fix': {
  const runId = ulid();
  const ws = ...; // existing
  const pipeline = new Pipeline(buildFixFlowRegistry({
    agentManager,
    emit: (e, p) => broadcast({ type: 'project-event', payload: { event: e, ...p } }),
  }));

  // Lifecycle hooks — mirror build flow
  attachAuditLogHook(pipeline.bus, { runId });
  attachDashboardStateHook(pipeline.bus, {
    statePath: join(ANVIL_HOME, 'state.json'),
    debounceMs: 250,
  });
  attachCostTrackerHook(pipeline.bus, { onUpdate: broadcastCostLedger });

  // Stage transitions broadcast for Active Runs UI
  pipeline.bus.on('step:started', ({ stepId }) => {
    activeRuns.get(runId)!.stages.push({ name: stepId, status: 'running', startedAt: new Date().toISOString() });
    broadcastActiveRuns();
  });
  pipeline.bus.on('step:completed', ({ stepId }) => {
    const stage = activeRuns.get(runId)!.stages.find((s) => s.name === stepId);
    if (stage) {
      stage.status = 'completed';
      stage.completedAt = new Date().toISOString();
    }
    broadcastActiveRuns();
  });
  pipeline.bus.on('step:failed', ({ stepId, error }) => {
    const stage = activeRuns.get(runId)!.stages.find((s) => s.name === stepId);
    if (stage) {
      stage.status = 'failed';
      stage.error = error.message;
    }
    broadcastActiveRuns();
  });

  // Active run record up front so UI sees a running entry immediately
  activeRuns.set(runId, {
    id: runId,
    type: 'fix',
    project,
    description,
    status: 'running',
    startedAt: Date.now(),
    activities: [],
    prUrls: new Set(),
    stages: [],          // populated by hooks above
  });
  broadcastActiveRuns();

  // Run async; don't block the WS handler
  pipeline.run({
    runId,
    workspaceDir: getWorkspaceFromConfig(project) || join(ANVIL_HOME, 'workspaces', project),
    input: {
      project,
      description,
      repoNames,
      repoPaths,
      model,
      maxFixAttempts: 3,
    },
  }).then(async () => {
    const run = activeRuns.get(runId)!;
    run.status = 'completed';
    run.completedAt = Date.now();

    // Memory hygiene — record episode + reflect (uses existing helpers)
    await recordRunEpisodeAndReflect(run);
  }).catch((err) => {
    const run = activeRuns.get(runId)!;
    run.status = 'failed';
    run.error = err.message;
    broadcastActiveRuns();
  });

  break;
}
```

### F.5 — Active Runs UI: render multi-stage progress (15 min)

The Active Runs card currently renders a single status pill for Fix
runs. Update it to render the same stage list it renders for Build
runs (which already supports `stages: Stage[]`).

In `ActiveRunsPage.tsx` and the sidebar tile component:
- Detect `run.type === 'fix' && run.stages.length > 0` — render the
  stage strip (fix → validate → fix-loop) with per-stage status dots.
- Reuse the existing Build stage renderer; the data shape is the same.

### F.6 — Routing card stays as-is (0 min)

Now that the Fix flow ACTUALLY runs three stages, the routing card's
`fix: ['fix', 'fix-loop', 'validate']` list at `dashboard-server.ts:3847`
is correct — no trim needed. (The list is reordered to `['fix',
'validate', 'fix-loop']` to match the actual pipeline order.)

### F.7 — Tests (30 min)

Add to `packages/dashboard/server/__tests__/`:

- `fix-flow.test.ts` — runs the registry against fake agentManager
  + fake validate that returns failed=false on attempt 1 (happy path),
  then a separate test where attempt 1 fails / attempt 2 passes
  (fix-loop retry path), then exhaustion (3 failed attempts).
- Mock `agentManager.spawn` to return synthetic agent ids; mock
  `waitForAgent` to return canned outputs.
- Assert: `step:started` / `step:completed` events fire in order
  for every stage; `state.json` is written; cost ledger updates.

### F.8 — Validation

- Manual: trigger a Fix run on a real project with a known bug
  (e.g. a typo causing tests to fail).
- Verify in Active Runs:
  - Three stage pills appear: fix → validate → fix-loop.
  - Stage pills update in real time as steps transition.
  - On final pass, run shows Completed with cost > $0.
  - Memory page shows new proposals from reflection after run ends.
- Verify rejection path:
  - Bug that's too complex for the model → fix-loop exhausts after
    3 attempts → run marked Failed with the expected error message.
- Routing card: visit /home in Fix mode, confirm the three rows are
  in the right order and each resolves to a model.

### Watch-outs

- `parallelism: 'per-repo'` on the `fix` and `validate` steps requires
  `ctx.input.repoNames` to be populated. For single-workspace
  projects, the runner falls back to a single-workspace path —
  preserve that.
- `runFixLoop` already maintains `priorByRepo` / `priorSingleId`
  across attempts — wire it through ctx.shared so attempts 2+ resume
  the prior agent session instead of spawning fresh.
- Permissions: every spawn site MUST thread `allowedTools:
  allowedToolsForStage(stepId)` (per the dashboard CLAUDE.md
  Conventions section). Forgetting one is the canonical
  "qwen ran but produced no diff" symptom.
- Validate step needs a "no validate command configured" escape
  hatch — if the project's `factory.yaml` or `project.yaml` has
  no validate command, skip validate (and therefore fix-loop) and
  return the fix's agent diff as-is. Log a warning so the user
  knows.
- After the run completes, recordPrEpisode requires a PR URL. If
  the fix flow doesn't produce a PR (no ship stage), pass an
  empty `prUrls` set — recordPrEpisode tolerates that and just
  records the run as an episode without PR provenance.
- Reflection runs by default after the fix flow (per Task A's
  cutover) — make sure `runSummary` includes the validate failure
  counts so the lessons extractor has something to chew on.

---

## Cross-cutting checks at the end

- [ ] `npm run build` clean across all packages
- [ ] `npm -w @anvil-dev/dashboard run test:server` — no NEW failures
      (the 6 pre-existing remain until separately fixed)
- [ ] `npm -w @esankhan3/anvil-cli run build` succeeds and bundles
      the fresh dashboard into `cli/dist/dashboard/dist/`
- [ ] Every page renders a skeleton on first paint with the dashboard
      server stopped — no instant "no providers detected" / blank list
- [ ] Trigger a Fix run end-to-end:
      - Stage strip animates fix → validate → fix-loop
      - On success: Completed status, cost > 0, reflection proposals
        appear in Memory page within 30 m (or trigger
        `ANVIL_SLEEPTIME_INTERVAL_MS=10000` for faster verification)
      - On exhaustion: Failed status with attempt count in error
- [ ] Routing card on /home with Fix mode shows
      `fix → validate → fix-loop` in that order, all resolved.

## Deliberately out of scope

- Splitting validate per-language (TS / Go / Python). The single
  validate step assumes the project provides one validate command
  that runs everything.
- Plan / Review getting their own Pipeline orchestrators.
  They're already one-shot agent spawns and that's deliberate
  for fast turnaround.
- Replacing lucide with phosphor (still deferred).
- Fixing the 6 pre-existing dashboard server test failures.

## Sequencing

L.1 → L.2 → L.3 → F.1 → F.2 → F.3 → F.4 → F.5 → F.7 → F.8.

L can ship as a single PR (one commit per phase, one PR overall);
F should ship as 2 PRs — one for F.1 + F.2 (step factories, no
behaviour change) and one for F.3 + F.4 + F.5 + F.7 (registry +
wiring + UI + tests, behaviour change).
