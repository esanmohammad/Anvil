# Post-Compaction Follow-Up Plan

Five concrete tasks that finish the work started in PRs 1–5. Self-contained
so this can be executed cold after a context compaction. Branch:
`feat/plan-generation` (do not push without explicit user approval).

## Context recap (what already shipped)

- PR 1 — `chore(dashboard): gate cost / budget surfaces as Coming Soon` (eaa7010)
- PR 2 — `feat(dashboard): read-only routing table from stage-policy.yaml` (152a153)
- PR 3 — `feat: extract @anvil/convention-core and wire into prompt` (db86c3b)
- PR 4a — `feat(dashboard): wire memory hygiene through memory-core primitives` (b63b429)
- PR 4b — `feat: complete memory hygiene — reflection + BM25 + sleeptime + UI` (9276034)
- PR 5 — `feat(dashboard): terminal-forge rebrand — anchor pages on new tokens` (970e57e)

The five remaining items below were called out by the user as caveats or
follow-ups. Order is independent — pick any first; total ~1.5 days.

---

## Task A — Reflection on by default

**Goal:** every completed pipeline run runs `reflectOnRun` automatically;
`ANVIL_REFLECTION=off` is the only opt-out. Today the env var defaults to
`'off'` and the user must flip `'1'` / `'always'` to enable.

### Files to change

1. **`packages/dashboard/server/dashboard-server.ts`** — `persistRunRecord`
   function (around line 4830 — search for `ANVIL_REFLECTION`).

   **Before:**
   ```ts
   const reflectionMode = process.env.ANVIL_REFLECTION ?? 'off';
   const shouldReflect =
     reflectionMode === '1' || reflectionMode === 'always' ||
     (reflectionMode === 'on-success' && state.status === 'completed');
   ```

   **After:**
   ```ts
   // Reflection runs by default at end of every pipeline run.
   // ANVIL_REFLECTION=off | 0 | false disables.
   // ANVIL_REFLECTION=on-success restricts to status === 'completed'.
   const reflectionMode = (process.env.ANVIL_REFLECTION ?? 'always').toLowerCase();
   const reflectionDisabled = ['off', '0', 'false', 'no'].includes(reflectionMode);
   const shouldReflect = !reflectionDisabled &&
     (reflectionMode !== 'on-success' || state.status === 'completed');
   ```

2. **`packages/dashboard/src/components/memory/MemoryPage.tsx`** — add a
   small status hint near the page header showing reflection state. Read
   from a new WS event `get-memory-config` that returns
   `{ reflectionEnabled: boolean, sleeptimeIntervalMs: number }`.

   - Add the WS handler in `dashboard-server.ts` next to `list-memories`:
     ```ts
     case 'get-memory-config': {
       const m = (process.env.ANVIL_REFLECTION ?? 'always').toLowerCase();
       const reflectionEnabled = !['off', '0', 'false', 'no'].includes(m);
       const interval = Number(process.env.ANVIL_SLEEPTIME_INTERVAL_MS ?? 30 * 60_000);
       ws.send(JSON.stringify({
         type: 'memory-config',
         payload: { reflectionEnabled, sleeptimeIntervalMs: interval, mode: m },
       }));
       break;
     }
     ```
   - Render in MemoryPage as a single-line badge under the stats bar:
     `Reflection: on (set ANVIL_REFLECTION=off to disable) · Sleeptime: every 30m`.

### Validation

- `node packages/dashboard/server/dashboard-server.js` boots without
  setting `ANVIL_REFLECTION`. First completed run logs
  `[dashboard] reflection enqueued N proposal(s) for run …`.
- Setting `ANVIL_REFLECTION=off` skips reflection silently.
- MemoryPage shows `Reflection: on` by default.

### Watch-outs

- Reflection costs a small-tier model call per run (~$0.005). On a dev
  machine with no `ANTHROPIC_API_KEY` and no local Ollama, the
  `reflection-invoker.ts` will fail — the surrounding try/catch swallows
  this and logs `[dashboard] reflectOnRun failed: …`. Acceptable.
- The reflection prompt in `memory-core/src/reflect/prompts.ts` may need
  iteration over time. Don't fold prompt-tuning into this PR.

---

## Task B — Remove legacy memory formatter

**Goal:** `getStableMemoryBlock` has no fallback to the newest-first slice.
BM25 is the only retrieval path. Forces the system to write structured
memory or surface an empty block (which is honest).

### Files to change

1. **`packages/dashboard/server/pipeline-runner.ts`** — `getStableMemoryBlock`
   method (search `getStableMemoryBlock(): string`, around line 840).

   **Delete:**
   - `formatLegacyMemoryBlock` private method.
   - The `if (this.envelopeDisabled)` early-return that calls it.
   - The catch-block that falls back to it.

   **Keep:**
   - The cache invariant (`cachedMemoryBlock !== null` short-circuit).
   - The BM25 query path.

   **New shape:**
   ```ts
   private getStableMemoryBlock(): string {
     if (this.cachedMemoryBlock !== null) return this.cachedMemoryBlock;
     try {
       const store = this.memoryStore.unwrap();
       const projectNs = { scope: 'project' as const, projectId: this.config.project };
       const userNs = { scope: 'user' as const, projectId: this.config.project };
       const queryText = this.config.feature || '';
       const projectHits = queryText
         ? store.query(projectNs, { text: queryText, limit: 8 })
         : store.query(projectNs, { limit: 8 });
       const userHits = store.query(userNs, { limit: 5 });
       const projectBlock = projectHits.length > 0
         ? `## Recent project memories (BM25-ranked for "${queryText.slice(0, 60)}")\n` +
           projectHits.map((m) => `- [${m.kind}${m.subtype ? `:${m.subtype}` : ''}] ${formatContent(m.content)}`).join('\n')
         : '';
       const userBlock = userHits.length > 0
         ? `## User profile\n` + userHits.map((m) => `- ${formatContent(m.content)}`).join('\n')
         : '';
       const combined = [projectBlock, userBlock].filter(Boolean).join('\n\n');
       this.cachedMemoryBlock = combined.length > 4000
         ? combined.slice(0, 4000) + '\n... [memory truncated]'
         : combined;
     } catch (err) {
       console.warn('[pipeline] BM25 memory retrieval failed:', err);
       this.cachedMemoryBlock = '';
     }
     return this.cachedMemoryBlock;
   }
   ```

2. **`packages/dashboard/server/memory-store.ts`** — `MemoryStore` class.

   - Audit `formatForPrompt` callers via `grep -rn "formatForPrompt"
     packages/dashboard/server`. If only the just-deleted legacy path
     used it, remove the method too.
   - If kept (likely — WS handlers may surface it), tag it as
     `@deprecated` with a comment pointing to BM25 retrieval.

3. **Remove `ANVIL_PROMPT_ENVELOPE_DISABLED` references** in the same file.
   The legacy path was the rollback hatch; no rollback path now.
   - Remove the `envelopeDisabled` field declaration.
   - Remove every `if (this.envelopeDisabled)` short-circuit (search and
     destroy — there are several across the helpers).
   - The other cache helpers (`getStableProjectYamlSlice`, `getStableKbBlock`)
     keep their cache invariant but lose the env-disabled branch.

### Validation

- `npm -w @anvil-dev/dashboard run test:server` — no new failures.
- A run on a fresh project (no memory yet) sees empty `## Project Memories`
  block in the prompt. Verify by logging `getStableMemoryBlock()` output
  in dev mode.
- A run on a project with reflected memories sees BM25-ranked entries.

### Watch-outs

- `MemoryStore.formatForPrompt` may be called by the markdown migration
  path. Trace before deleting — if so, keep but mark deprecated.
- Test with `ANVIL_REFLECTION=off` for one run, then a follow-up run with
  it on, to confirm the empty → populated transition is graceful.

---

## Task C — Exhaustive UI rebrand sweep

**Goal:** every component renders on the terminal-forge palette. Today
~50 components still have inline hex literals from the old
Claude-inspired teal palette. Mechanical sweep.

### Audit commands

```bash
# Old palette literals to replace
grep -rln -E '#34D399|#10B981|#2BC48A|#3EE0A8' packages/dashboard/src
grep -rln -E '#F87171|#FBBF24|#60A5FA' packages/dashboard/src
grep -rln -E 'rgba\(52,\s*211,\s*153' packages/dashboard/src   # old teal rgba
grep -rln -E 'rgba\(248,\s*113,\s*113' packages/dashboard/src  # old red rgba
grep -rln -E 'rgba\(251,\s*191,\s*36'  packages/dashboard/src  # old yellow rgba
grep -rln -E 'rgba\(96,\s*165,\s*250'  packages/dashboard/src  # old blue rgba
grep -rln -E 'backdrop[Ff]ilter|backdrop-filter' packages/dashboard/src
grep -rln -E 'frosted' packages/dashboard/src
grep -rln -E "Inter[,'\"]" packages/dashboard/src              # stale font refs
```

### Replacement table

| Old literal | New token |
|---|---|
| `#34D399` `#10B981` `#2BC48A` `#3EE0A8` | `var(--accent)` (`#F0853F`) |
| `rgba(52, 211, 153, …)` | `var(--accent-muted)` or `var(--accent-subtle)` |
| `#F87171` | `var(--color-error)` (`#C97373`) |
| `rgba(248, 113, 113, …)` | `rgba(201, 115, 115, …)` |
| `#FBBF24` | `var(--color-warning)` (`#D4A24A`) |
| `rgba(251, 191, 36, …)` | `rgba(212, 162, 74, …)` |
| `#60A5FA` | `var(--color-info)` (`#6B8AAB`) |
| `rgba(96, 165, 250, …)` | `rgba(107, 138, 171, …)` |
| `#FFF` `#FFFFFF` (in inline styles) | `var(--text-primary)` |
| `#000` `#000000` | `var(--text-inverse)` (when on accent) or keep |
| `linear-gradient(…)` | solid `var(--accent)` (drop the gradient unless purposeful) |
| `backdrop-filter: blur(…)` | remove entirely; use solid `var(--bg-elevated-1)` instead |
| `Inter, …` | `var(--font-sans)` |
| `border-radius: 16+px` (hardcoded) | `var(--radius-lg)` (8px) — sharper |

### Sweep order (high-traffic first)

1. `components/home/HomePage.tsx`
2. `components/plan/PlanPage.tsx` + `components/plan/PlanCompare.tsx` + `components/plan/edit/*`
3. `components/review/ReviewPage.tsx` + `components/review/*`
4. `components/feed/*`
5. `components/run-feature/*`
6. `components/pipeline/*`
7. `components/output/*`
8. `components/insights/*` + `components/stats/*`
9. `components/history/*`
10. `components/knowledge-graph/*` (ForceGraph theming uses raw hex — careful)
11. `components/test/*`
12. `components/contracts/*`, `components/ci-triage/*`
13. `components/multi-project/*`, `components/pr-board/*`, `components/overview/*`
14. `components/clarification/*`, `components/diff/*`, `components/comparison/*`
15. `components/project-map/*`, `components/bound-tests/*`, `components/actions/*`

### Strategy

- Per file: open, run replacements with `sed`-style edits OR with the
  `Edit` tool's `replace_all`. Most replacements are direct token swaps.
- Drop bespoke gradients and tinted-blur cards — replace with solid
  surfaces + 1px hairlines.
- Lucide icon `strokeWidth` should be `1.75` everywhere (consistent line
  weight). Keep lucide for now — Phosphor swap is a separate concern.

### Validation

- `npm -w @anvil-dev/dashboard run build` — clean.
- Re-run audit greps; expect zero matches for the old palette.
- Manual eyeball: visit every route in the dev server. Look for stray
  green/teal pixels, soft drop shadows, glassmorphism, oversized radii.

### Watch-outs

- `ForceGraph.tsx` uses hex strings in a JS canvas-render path — those
  literals are passed to D3, not CSS. Same replacement table applies but
  via JS variables (e.g. `getComputedStyle(document.documentElement).getPropertyValue('--accent')`).
- The `cost-tier.ts` lib may have hardcoded tier thresholds with colors —
  audit separately.

---

## Task D — Vendor Geist font

**Goal:** `Geist` and `Geist Mono` render reliably on every machine, not
just ones that happen to have Geist installed locally. Today tokens.css
declares Geist with `system-ui` fallback — system is what most users see.

### Steps

1. **Download Geist + Geist Mono variable woff2 files.**
   - Source: https://github.com/vercel/geist-font (OFL, free).
   - Direct file URLs (variable axis):
     - `https://github.com/vercel/geist-font/raw/main/packages/next/dist/fonts/geist-sans/Geist[wght].woff2`
     - `https://github.com/vercel/geist-font/raw/main/packages/next/dist/fonts/geist-mono/GeistMono[wght].woff2`
   - Save as `packages/dashboard/public/fonts/Geist-Variable.woff2` and
     `packages/dashboard/public/fonts/GeistMono-Variable.woff2`.

   Verify with `curl` then commit the binary files. Sizes ~80–120KB each.

2. **Add `@font-face` to `packages/dashboard/src/styles/index.css`** at
   the top, before the `@import` lines:

   ```css
   @font-face {
     font-family: 'Geist';
     src: url('/fonts/Geist-Variable.woff2') format('woff2-variations'),
          url('/fonts/Geist-Variable.woff2') format('woff2');
     font-weight: 100 900;
     font-style: normal;
     font-display: swap;
   }

   @font-face {
     font-family: 'Geist Mono';
     src: url('/fonts/GeistMono-Variable.woff2') format('woff2-variations'),
          url('/fonts/GeistMono-Variable.woff2') format('woff2');
     font-weight: 100 900;
     font-style: normal;
     font-display: swap;
   }
   ```

3. **Vite config** (`packages/dashboard/vite.config.ts`) — `public/`
   serves at root by default. No config change needed. Verify with:
   `npm -w @anvil-dev/dashboard run dev` then `curl http://localhost:5173/fonts/Geist-Variable.woff2 -I` returns 200.

4. **Replace the fallback comment** in index.css (the block that says
   "We don't ship a webfont — Geist is preferred when the user has it
   locally") with a one-line note: "Geist + Geist Mono are vendored at
   /fonts/."

5. **Update `packages/dashboard/package.json` `files:` field** so the
   webfonts ship with `npm publish` (if this package is published) — add
   `public/fonts/*.woff2` to the bundle.

### Validation

- `npm -w @anvil-dev/dashboard run dev` — open DevTools → Network →
  reload → confirm `Geist-Variable.woff2` returns 200.
- Toggle DevTools → Rendering → "Disable cache". Inspect a heading's
  computed font-family — should show `Geist` not `system-ui`.
- Production build: `npm -w @anvil-dev/dashboard run build` —
  `dist/fonts/` should contain the woff2 files.

### Watch-outs

- Vite copies `public/` to `dist/` during build — if not, see
  `vite.config.ts` and ensure `publicDir` is default.
- Variable font axis support: `font-weight: 100 900` works in modern
  browsers. Older Safari (<12) drops to the lower bound, which is fine.
- Bundle size +~250KB for both fonts. Acceptable for a dev-tool dashboard.

---

## Task E — Auto-promote convention rules from reflection lessons

**Goal:** when reflection extracts a `semantic.fix-pattern` memory and
sleeptime ratifies it, automatically run `convention-core`'s
`checkAndPromote` so the lesson surfaces in every future run's
conventions block (not just memory). Closes the lesson → convention loop
described in the "5 compounding loops" discussion.

### Architecture

Memory-core's `consolidate(store, queue, ns, opts)` accepts a `decideFn`
that returns a `RatificationDecision`. We wrap `defaultDecide` with a
post-decision hook that:

1. Detects ratifications of `kind=semantic, subtype=fix-pattern`.
2. Extracts `error` and `fix` from the memory's content (the reflection
   prompt outputs structured JSON; we parse it).
3. Calls `convention-core`'s `checkAndPromote(paths, error, fix, project)`.
4. If `result.promoted`, the rule lands in `<conventionsDir>/<project>/rules.json`
   via the existing `convention-core` writer.

### Files to change

1. **`packages/dashboard/server/dashboard-server.ts`** — sleeptime
   scheduler block (search `runSleeptime` near the bottom of `startServer`).

   Replace:
   ```ts
   const result = await consolidate(store, queue, { scope: 'project', projectId: sys.name });
   ```

   With:
   ```ts
   const decideFn = await makePromotionAwareDecideFn(sys.name);
   const result = await consolidate(
     store,
     queue,
     { scope: 'project', projectId: sys.name },
     { decideFn },
   );
   ```

   Add the helper near the top of the same closure:
   ```ts
   import type { DecideFn } from '@anvil/memory-core';

   async function makePromotionAwareDecideFn(project: string): Promise<DecideFn> {
     const { defaultDecide } = await import('@anvil/memory-core');
     const { checkAndPromote } = await import('@anvil/convention-core');
     return async (store, proposal) => {
       const decision = await defaultDecide(store, proposal);
       try {
         if (
           proposal.candidate.kind === 'semantic' &&
           proposal.candidate.subtype === 'fix-pattern' &&
           (decision.kind === 'add' || decision.kind === 'merge-into')
         ) {
           const content = proposal.candidate.content as { error?: string; fix?: string } | string;
           const error = typeof content === 'string' ? content : content.error;
           const fix = typeof content === 'string' ? '' : (content.fix ?? '');
           if (error && fix) {
             const promoted = checkAndPromote(CONVENTION_PATHS, error, fix, project);
             if (promoted.promoted) {
               console.log(`[sleeptime] promoted convention rule for "${project}": ${promoted.rule?.id}`);
             }
           }
         }
       } catch (err) {
         console.warn('[sleeptime] promotion hook failed:', err);
       }
       return decision;
     };
   }
   ```

2. **`packages/convention-core/src/promotion/index.ts`** — `checkAndPromote`
   currently only returns the new rule; it doesn't write it to disk. Verify
   and extend if needed:

   ```ts
   export function checkAndPromote(
     paths: ConventionPaths,
     error: string,
     fix: string,
     project: string,
   ): PromotionResult {
     trackViolation(paths, error, fix, project);
     const count = getViolationCount(paths, error);

     if (count >= PROMOTION_THRESHOLD) {
       const rule = generateRule(error, fix, project);
       // PERSIST — append to <conventionsDir>/<project>/rules.json
       persistRule(paths, project, rule);
       return { promoted: true, count, rule };
     }
     return { promoted: false, count };
   }

   function persistRule(paths: ConventionPaths, project: string, rule: ConventionRule): void {
     const path = join(paths.conventionsDir, project, 'rules.json');
     mkdirSync(dirname(path), { recursive: true });
     let existing: ConventionRule[] = [];
     if (existsSync(path)) {
       try {
         const raw = JSON.parse(readFileSync(path, 'utf-8')) as { rules?: ConventionRule[] };
         existing = Array.isArray(raw.rules) ? raw.rules : [];
       } catch { /* */ }
     }
     // De-dupe by id
     if (existing.some((r) => r.id === rule.id)) return;
     existing.push(rule);
     writeFileSync(path, JSON.stringify({ rules: existing }, null, 2), 'utf-8');
   }
   ```

   - Imports needed: `existsSync, mkdirSync, readFileSync, writeFileSync` from `node:fs`, `dirname, join` from `node:path`.
   - Add `persistRule` to the package barrel if testable from outside.

3. **`packages/convention-core/src/index.ts`** — re-export
   `persistRule` (optional; useful for tests).

### Reflection prompt update (separate, smaller)

The reflection prompt in `memory-core/src/reflect/prompts.ts`
(`REFLECTION_SYSTEM_PROMPT`) needs a contract: when emitting a
`fix-pattern` proposal, the `content` field MUST be an object with
`error` (the failure signal) and `fix` (the action that resolved it).

Audit the existing prompt (`memory-core/src/reflect/prompts.ts`). If
fix-pattern format isn't already structured, update it. Don't change
unless verified — memory-core may already do this.

### Validation

- Trigger 3 runs that produce the same fix-pattern (e.g. "Go modules
  require `go mod tidy` after dep changes"). After the third
  ratification:
  - `~/.anvil/conventions/<project>/rules.json` has a new rule.
  - The next run's prompt's `## Conventions` block includes it (via
    `loadConventions`).
  - Sleeptime log: `[sleeptime] promoted convention rule for "<project>": …`.
- Negative path: a `semantic.approach` (not fix-pattern) memory ratifies
  → no promotion attempt.

### Watch-outs

- `defaultDecide` currently returns `RatificationDecision` synchronously
  in some paths and asynchronously in others. The wrapper supports both
  via `await`.
- Memory-core may not yet have `defaultDecide` exported from the public
  barrel — check `packages/memory-core/src/index.ts` and add if missing.
- `convention-core`'s rule schema (`ConventionRule` from
  `rules/types.ts`) and the review-rules' local schema (in
  `dashboard/server/review-rules/conventions.ts`) don't fully overlap.
  Verify the auto-generated rule is consumable by both — if the review
  prepass needs `avoidPattern` or `status: 'enforced'` to fire,
  `generateRule` must populate them.

---

## Sequencing

Independent — pick any order. Recommended: D first (font is purely
additive, no behaviour risk), then A + B together (small, related), then
E, then C last (largest LOC volume).

Day-budget estimate:
- A: 1 hour
- B: 1 hour
- C: 4–6 hours (mechanical sweep across ~50 files)
- D: 30 minutes (assuming font download succeeds)
- E: 2–3 hours (rule persistence + integration test)

**Total: 1 focused day.**

## Cross-cutting checks at the end

- [ ] `npm run build` clean across all packages
- [ ] `npm -w @anvil-dev/dashboard run test:server` — no NEW failures
      (the 6 pre-existing remain until separately fixed)
- [ ] Walk every route in the dev server — confirm new tokens, no stray
      green/teal pixels
- [ ] Run a real Build flow with `ANVIL_REFLECTION` unset — confirm
      reflection fires by default and proposals appear in the Memory page
- [ ] Verify a fix-pattern repeated 3× promotes to `rules.json`
- [ ] `ls packages/dashboard/dist/fonts/` shows woff2 files

## What this plan deliberately leaves out

- Phosphor icon swap (still on lucide; deferred to a follow-up).
- Drift detection sweeps (`verifyCodeBindings`) — already in memory-core,
  not yet scheduled.
- Cross-project user memory transfer — needs a memory-core ADR.
- Active LLM-classifier contradiction detection at write time — deferred.
- A/B instrumentation on memory hits — deferred.
