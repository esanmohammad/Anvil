# Pipeline Policy + Agent Q&A: On-By-Default + Dedicated UI Page

**Goal:** ship two related capabilities so users get useful, controllable
review behaviour out of the box without ever touching a yaml file:

1. **Reviewer pause / note / edit / rerun-from / iterate** fires on **every**
   project by default; users manage gating + cost rules from a dedicated
   **`/policy`** page in the dashboard with helpful explanations beside
   every control.
2. **Agent Q&A** — agents in `clarify`, `requirements`, `repo-requirements`,
   and `specs` may pause and ask up to N most-relevant questions before
   producing the artifact. Questions appear in the stage card with a
   text input; answers feed back into the same agent session and inform
   the artifact it eventually produces. The cap is configurable; agent
   confidence opts out of asking entirely.

These two capabilities compose cleanly — Q&A is **intra-stage** (input
gathering by the agent), policy pause is **inter-stage** (output
validation by the human). See §A for the combined flow diagram.

**Branch:** new branch off `feat/harness-improvment` once approved.

**Non-negotiables:**
- Default behavior changes silently for every existing project on the
  user's machine — verify the rollout note in §10 before merging.
- Every existing yaml on disk is preserved + still loaded; the dashboard
  only writes to the overlay JSON. Power users keep yaml authority.
- WS event vocabulary stays additive (new `pipeline-policy-saved`,
  `stage-question` events; existing `pipeline-policy` /
  `pipeline-policy-updated` / `clarify-question` / `waiting-for-input`
  / `user-input` shapes extended, never broken).
- Tests at baseline (511/518 dashboard, 340/340 core-pipeline) at every
  commit.

---

## §A. Two gates: Q&A and Policy — how they compose

The two capabilities serve **different purposes** at **different points**
in a stage's lifecycle:

| Gate | When | Triggered by | Purpose |
|---|---|---|---|
| **Q&A (intra-stage)** | DURING the stage, before artifact is produced | Agent's own decision (it needs info) | Input gathering — agent admits uncertainty up front instead of guessing wrong |
| **Policy pause (inter-stage)** | AFTER the stage's artifact lands | `evaluatePolicy()` against user's policy settings | Output validation — human verifies the agent didn't hallucinate or drift |

### End-to-end flow for a single stage

```
Stage starts
   │
   ▼
Agent's first turn (multi-turn session for clarify/requirements/specs;
                    one-shot for tasks/build/etc.)
   │
   ├── (a) Confident → emits final artifact directly
   │       │
   │       ▼
   │     Stage marked "completed", artifact saved
   │
   └── (b) Has questions → emits up-to-N most-relevant questions in
   │                         <questions>...</questions> block
   │       │
   │       ▼
   │     parseStageQuestions() → state.stages[i].questions = [...]
   │     state.stages[i].status = 'waiting'
   │     broadcast 'stage-question' (per question) +
   │     broadcast 'state-change' (so card re-renders)
   │       │
   │       ▼
   │     Stage card shows StageQuestionsPanel with one row per question
   │     Each row: question text + textarea + Submit button
   │       │
   │       ▼
   │     User answers in card → WS user-input(stageIndex, repoName?, qIdx, text)
   │     → server calls runner.provideStageAnswer(stageIndex, repoName?, qIdx, text)
   │     → runner records answer in state.stages[i].questions[qIdx].answer
   │       │
   │       ▼
   │     When all questions answered → resolve agent's input promise
   │     with formatStageAnswers() block
   │       │
   │       ▼
   │     Agent resumes → produces final artifact
   │       │
   │       ▼
   │     Stage marked "completed", artifact saved (Q&A history kept on state)
   │
   ▼
After-stage hook fires (THIS is where pipeline policy applies)
   │
   ├── policy.enabled === false → continue silently
   ├── policy says auto-approve (low risk + high confidence) → continue silently
   └── policy says pause → pauseStore.pause() → modal opens
         │
         └── Modal shows artifact + collapsed "Q&A from this stage" disclosure
             User picks approve / approve-with-note / modify-artifact /
                       rerun-from / iterate-with-note
   │
   ▼
Next stage starts
```

### Three orthogonal user settings on `/policy`

1. **Pause for review** (master toggle — controls policy pauses)
2. **Which stages pause** (pauseAfter checkboxes — controls policy pauses)
3. **Agents may ask clarifying questions** (toggle + max-questions slider — controls Q&A)

Each setting is independently controllable. A "high-touch" run interleaves
Q&A and pauses; a "high-trust" run with autoApprove + agent-confident
runs end-to-end with no interruptions at all.

### Compositional outcomes

| Policy pause | Q&A enabled | Agent confident | Outcome |
|---|---|---|---|
| ON | ON | NO | Q&A fires → user answers → artifact → policy pause → review modal |
| ON | ON | YES | Artifact direct → policy pause → review modal |
| ON | OFF | n/a | Artifact direct → policy pause → review modal |
| OFF | ON | NO | Q&A fires → user answers → artifact → next stage (no pause) |
| OFF | ON | YES | Artifact direct → next stage (no pause) |
| OFF | OFF | n/a | Artifact direct → next stage (silent run, today's behavior with no policy file) |

### Useful integration at the seam

When the post-stage review modal opens, it shows a collapsed **"Q&A from
this stage"** disclosure above the artifact. The reviewer sees what the
agent asked + what the user answered, so reviewing the artifact has full
context without requiring memory of the earlier exchange. Cheap to wire
(the Q&A pairs already accumulate in `state.stages[i].questions`) and
high-leverage for "why does this say what it says?" moments.

---

## 1. Status quo (verified, not assumed)

### What ships today

| Surface | State |
|---|---|
| `pipeline-policy.yaml` (per project) | Optional. Without it, `loadPolicy()` returns `null` → `setAfterStageHook` returns immediately → **no pause ever fires**. |
| `pipeline-policy.overlay.json` (per project) | Layered on top of yaml. Today only `cost` block is honoured (server validates only cost fields in the `update-pipeline-policy` patch). |
| `defaultPolicy()` function | Exists in `pipeline-policy.ts:416–423` returning `{ defaults: { pauseAfter: ['plan'] }, paths: [], cost: { onBreach: 'ask' } }`. **Currently unused** — `loadPolicy()` doesn't call it. |
| `get-pipeline-policy` WS handler | Returns the merged policy + raw overlay (`dashboard-server.ts:4458`). |
| `update-pipeline-policy` WS handler | Accepts `{ patch: { cost: {...} } }` ONLY (`dashboard-server.ts:4475`). Pause/auto-approve fields are **not** writable from the dashboard today. |
| Settings page | "Cost & Approvals" section is a `disabled=true` placeholder reading "Coming soon" (`SettingsPage.tsx:219`). |
| Reviewer modal (`PlanReviewModal.tsx`) | Fully wired downstream of `pipeline-paused` broadcast, but the broadcast itself never fires when policy is null. |
| Filesystem reality on the user's machine | `~/.anvil/projects/pet-company/pipeline-policy.yaml.bak` (disabled), `~/.anvil/projects/space-company/pipeline-policy.yaml` (active). |

### Why this matters

The user's experience: started a run on `pet-company`, never saw the
review modal, asked why. Cause: policy file is `.bak`-renamed →
`loadPolicy → null` → silent. The feature is built but the activation
default is "off".

This plan flips the default to "on" and gives users a real UI so they
never have to touch yaml.

---

## 2. Goals + non-goals

### Goals

1. **On by default for new + existing projects.** Zero-config, the
   reviewer pause fires after the planning phase on every project's
   first run.
2. **Dedicated `/policy` page** (not buried in Settings) so the feature
   is discoverable.
3. **Explanations beside every control.** Every toggle, slider, and
   threshold has a one-line plain-language description + a short
   "what happens if I change this" hint.
4. **Reversible.** Master toggle to disable pauses for a specific
   project without deleting the yaml.
5. **Yaml-compatible.** Existing yaml stays authoritative; dashboard
   writes overlay JSON only. Power users keep their workflow.
6. **Cost limits in the same place.** Per-run / daily / per-stage caps
   already exist in the schema — surface them here too.
7. **Agent Q&A on planning stages.** The agent in `clarify`,
   `requirements`, `repo-requirements`, and `specs` may ask up to N
   most-relevant questions before producing the artifact; questions
   surface in the stage card; user answers feed back into the same
   agent session. Confident agents skip Q&A entirely.
8. **Q&A history on review.** When a stage pauses post-artifact for
   policy review, the modal shows the Q&A history for that stage so
   the reviewer has full context for the artifact.

### Non-goals (deferred)

- Path-rule UI (per-glob `pauseAfter` rules). The schema supports them;
  editing globs in a UI is bespoke + infrequently needed. Add a
  read-only "Rules from yaml" panel showing what's loaded; no edit UI
  in v1.
- Reviewer assignment UI (`reviewers` block).
- Multi-project bulk policy editor.
- Importing/exporting policy as yaml (the overlay export is enough for
  v1 — yaml stays a power-user tool).
- Q&A on `tasks`, `build`, `test`, `validate`, `ship`. The build agent
  asking "should I use map or filter?" is exactly the wrong UX. Q&A is
  scoped to *planning* stages where uncertainty is structural, not
  implementation stages where the cost of the agent guessing wrong is
  cheap to undo with a fix-loop iteration.
- Per-stage Q&A overrides (e.g. "ask up to 3 in clarify but 7 in
  specs"). One global cap for v1; raise this in v2 if needed.

---

## 3. UX — `/policy` page design

### Route + navigation

- New route: `/policy` (Vue/React-router). Sidebar entry **"Policy"**
  with a `shield` or `gavel` icon, between **"Active Runs"** and
  **"Settings"**.
- Page header: project selector (same component as elsewhere) + a
  status pill: **"On — pausing after Plan"** (green) or **"Off"**
  (grey) depending on `policy.enabled`.
- Empty state when no project selected: prompt to pick a project.
- Optional deep-link: `/policy?project=<slug>` pre-selects.

### Page layout (top to bottom)

```
┌────────────────────────────────────────────────────────────────┐
│  Policy — pet-company                          [Status: On]   │
│  Decide when Anvil pauses for human review and how it spends. │
├────────────────────────────────────────────────────────────────┤
│  ┌── Master switch ──────────────────────────────────────┐   │
│  │ ⬤ Pause for human review                              │   │
│  │   When on, Anvil stops between stages so you can      │   │
│  │   approve, edit, or roll back before continuing.      │   │
│  │   When off, runs go end-to-end without any prompts.   │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                                │
│  ┌── When to pause ──────────────────────────────────────┐   │
│  │ Pause after each of these stages completes:           │   │
│  │   ☑ Plan          [recommended]                       │   │
│  │     The agent has researched + written a plan.        │   │
│  │     Pausing here is the cheapest place to course-     │   │
│  │     correct — undoing later costs more.               │   │
│  │                                                        │   │
│  │   ☐ Implement                                          │   │
│  │     The agent has written code. Pausing here lets     │   │
│  │     you spot regressions before tests run.            │   │
│  │                                                        │   │
│  │   ☐ Review     ☐ Test     ☐ Ship                      │   │
│  │     (compact rows with the same hint pattern)         │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                                │
│  ┌── Skip the pause when… ──────────────────────────────┐   │
│  │ Auto-approve when both conditions hold:                │   │
│  │                                                        │   │
│  │ Risk is at or below: ⊙ Low  ○ Medium  ○ Always pause │   │
│  │   Anvil scores every plan for risk based on which     │   │
│  │   files change. Low = config-only, docs, isolated     │   │
│  │   modules. Medium = touches a shared package.         │   │
│  │                                                        │   │
│  │ Confidence is at least: ━━━━●━━━━ 0.85               │   │
│  │   The planner's self-rated confidence (0–1). Below    │   │
│  │   this threshold, Anvil pauses for review even on     │   │
│  │   low-risk plans.                                     │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                                │
│  ┌── Cost limits ────────────────────────────────────────┐   │
│  │ When a run hits a cap, Anvil ⊙ asks  ○ stops  ○ keeps │   │
│  │   going.                                               │   │
│  │                                                        │   │
│  │ Per-run cap:           [$  10.00 ]                    │   │
│  │ Per-day cap:           [$  30.00 ]                    │   │
│  │ Per-stage caps:                                        │   │
│  │   Implement: $12   Review: $3   Test: $3              │   │
│  │                                                        │   │
│  │ Always approve overages below: [$ 0.15]               │   │
│  │   Tiny overshoots (typo-level retries) won't ping.    │   │
│  │ Grace window: ━━━●━━━ 60 s                            │   │
│  │   Keep agents running this long while waiting on a    │   │
│  │   cost decision so demos don't stall.                 │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                                │
│  ┌── Agent questions (Q&A) ─────────────────────────────┐   │
│  │ ⬤ Allow agents to ask clarifying questions            │   │
│  │   When on, agents in Clarify, Requirements, and       │   │
│  │   Specs can pause and ask you up to N questions       │   │
│  │   before producing the artifact. Questions appear     │   │
│  │   in the stage card with a place to type your answer. │   │
│  │   When off, agents always produce the artifact in     │   │
│  │   one shot (faster, but easier to drift).             │   │
│  │                                                        │   │
│  │ Maximum questions per stage: ━━━●━━ 5                 │   │
│  │   The agent picks the N most-relevant questions. It   │   │
│  │   may also choose to ask none if it's confident.      │   │
│  │                                                        │   │
│  │ Stages where Q&A applies:                              │   │
│  │   Always: Clarify, Requirements, Specs                 │   │
│  │   Never:  Tasks, Build, Test, Validate, Ship           │   │
│  │   (Build/Test/etc. ask via the fix loop instead.)      │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                                │
│  ┌── Notifications ──────────────────────────────────────┐   │
│  │ ☐ Slack    ☐ Email                                   │   │
│  │ Auto-action after no response: [ 2 ] hours            │   │
│  │   If a reviewer doesn't decide in time, Anvil…        │   │
│  │   ⊙ stops the run  ○ approves and continues          │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                                │
│  ┌── Rules from yaml (read-only) ────────────────────────┐   │
│  │ Path overrides loaded from pipeline-policy.yaml:      │   │
│  │ • ui/src/components/**     pause after [plan, review] │   │
│  │ • web/src/pages/Booking…   pause after [plan, impl…]  │   │
│  │ • **/*.md                  auto-approve              │   │
│  │ Edit rules by editing the yaml file directly:         │   │
│  │   ~/.anvil/projects/<slug>/pipeline-policy.yaml      │   │
│  └────────────────────────────────────────────────────────┘   │
│                                                                │
│  [ Cancel ]                                  [ Save changes ] │
└────────────────────────────────────────────────────────────────┘
```

### Copy library (every string lives here, no inline strings in code)

A `policy-copy.ts` module holds the strings so future copy edits don't
require touching component logic.

```ts
export const POLICY_COPY = {
  pageTitle: 'Policy',
  pageSubtitle: 'Decide when Anvil pauses for human review and how it spends.',
  master: {
    label: 'Pause for human review',
    on: 'When on, Anvil stops between stages so you can approve, edit, or roll back before continuing.',
    off: 'When off, runs go end-to-end without any prompts.',
  },
  pauseAfter: {
    title: 'When to pause',
    description: 'Pause after each of these stages completes:',
    plan: {
      label: 'Plan',
      hint: 'The agent has researched and written a plan. The cheapest moment to course-correct — undoing later costs more.',
      recommended: true,
    },
    implement: {
      label: 'Implement',
      hint: 'The agent has written code. Pausing here lets you spot regressions before tests run.',
    },
    review: {
      label: 'Review',
      hint: 'Validation pass complete. Pausing here lets you eyeball the agent\'s self-review before merging.',
    },
    test: {
      label: 'Test',
      hint: 'Tests have run. Pausing here lets you decide whether failures are real before triggering the fix loop.',
    },
    ship: {
      label: 'Ship',
      hint: 'Right before PR creation / deploy. Pausing here gives one last sanity check before the change leaves the agent\'s sandbox.',
    },
  },
  autoApprove: {
    title: 'Skip the pause when…',
    description: 'Auto-approve when BOTH conditions hold:',
    riskLabel: 'Risk is at or below',
    riskHint: 'Anvil scores every plan for risk based on which files change. Low = config-only, docs, isolated modules. Medium = touches a shared package. High = always pauses.',
    confidenceLabel: 'Confidence is at least',
    confidenceHint: 'The planner\'s self-rated confidence (0–1). Below this threshold, Anvil pauses for review even on low-risk plans.',
  },
  cost: {
    title: 'Cost limits',
    onBreachLabel: 'When a run hits a cap, Anvil',
    onBreachOptions: { ask: 'asks', autoReject: 'stops', autoApprove: 'keeps going' },
    perRun: 'Per-run cap',
    perDay: 'Per-day cap',
    perStage: 'Per-stage caps',
    autoApproveBelow: 'Always approve overages below',
    autoApproveBelowHint: 'Tiny overshoots (typo-level retries) won\'t ping anyone.',
    grace: 'Grace window',
    graceHint: 'Keep agents running this long while waiting on a cost decision so demos don\'t stall.',
  },
  qa: {
    title: 'Agent questions (Q&A)',
    enableLabel: 'Allow agents to ask clarifying questions',
    enableHint: 'When on, agents in Clarify, Requirements, and Specs can pause and ask you up to N questions before producing the artifact. Questions appear in the stage card with a place to type your answer. When off, agents always produce the artifact in one shot — faster, but easier to drift.',
    maxLabel: 'Maximum questions per stage',
    maxHint: 'The agent picks the N most-relevant questions. It may also choose to ask none if it\'s already confident.',
    scope: 'Q&A is enabled on the planning stages (Clarify, Requirements, Specs). Build, Test, Validate, and Ship don\'t use Q&A — they recover via the fix loop instead.',
  },
  notifications: {
    title: 'Notifications',
    slack: 'Slack',
    email: 'Email',
    timeoutLabel: 'Auto-action after no response',
    timeoutHint: 'If a reviewer doesn\'t decide in time, Anvil applies the action below.',
  },
  paths: {
    title: 'Rules from yaml (read-only)',
    description: 'Path overrides loaded from pipeline-policy.yaml. To edit, open the file directly:',
    pathHint: '~/.anvil/projects/<slug>/pipeline-policy.yaml',
    empty: 'No path rules. Defaults above apply to every file.',
  },
  toast: {
    saved: 'Policy saved',
    saveFailed: 'Save failed',
    enabledOn: 'Pauses are now ON for this project',
    enabledOff: 'Pauses are now OFF for this project',
  },
};
```

### Interaction notes

- **Save button is disabled until something changes.** Compare current
  form state to the loaded server policy. Use a deep-equal helper.
- **Master switch off → grey out + disable** the "When to pause" and
  "Skip the pause when…" sections (visually communicate they don't
  apply).
- **Cost section never greys** — cost limits enforce regardless of
  pause settings.
- **Per-stage cap rows are folded under a "Show per-stage" disclosure**
  so the panel doesn't dominate the page on first paint.
- **"Recommended" badge** beside "Plan" in `pauseAfter` so first-time
  users know the safe default.
- **Confirmation modal** when the master switch is toggled off:
  > "Turn off pauses for `<project>`? Runs will go end-to-end with no
  > review prompts. You can turn this back on any time."
- **No confirmation** for individual stage checkboxes or threshold
  changes — they auto-save on Save.

---

## 4. Default policy

### Built-in default (returned by `loadPolicy` when no yaml exists)

```ts
const BUILTIN_DEFAULT_POLICY: PipelinePolicy = {
  version: POLICY_SCHEMA_VERSION,
  enabled: true,
  defaults: {
    pauseAfter: ['plan'],
    autoApproveIfRisk: 'low',
    autoApproveIfConfidence: 0.85,
  },
  paths: [],
  cost: {
    onBreach: 'ask',
    autoApproveBelow: 0.15,
    graceWindowSeconds: 60,
    limits: {
      perRun: 10.00,
      perProjectDaily: 30.00,
    },
  },
  qa: {
    enabled: true,
    maxQuestionsPerStage: 5,
    // Stages — fixed in v1, no per-stage override surface.
    // Hard-coded list: ['clarify', 'requirements', 'repo-requirements', 'specs']
  },
  notifications: {
    slack: false,
    email: false,
    timeoutHours: 2,
  },
};
```

**Rationale for each choice:**

| Setting | Default | Why |
|---|---|---|
| `enabled` | `true` | The whole point of this plan. |
| `pauseAfter: ['plan']` | one stage | Most actionable feedback fits in one pause; five pauses would feel obnoxious on first run. |
| `autoApproveIfRisk: 'low'` | enabled | Trivial doc/config changes shouldn't ping the user. |
| `autoApproveIfConfidence: 0.85` | high bar | Below this, even a low-risk change pauses. |
| `cost.onBreach: 'ask'` | inherited from current default | Don't silently kill a run; don't silently keep spending. |
| `cost.limits.perRun: $10` | conservative | A reasonable demo budget; users with bigger workloads will adjust. |
| `cost.limits.perProjectDaily: $30` | conservative | Same — visible enough that runaway scripts pop a breach modal. |
| `cost.autoApproveBelow: 0.15` | inherited | Typo-level overshoots (~$0.15) don't ping. |
| `qa.enabled: true` | on | Higher-quality artifacts; the agent is the one deciding when to ask, so cost is opt-in by the agent itself. |
| `qa.maxQuestionsPerStage: 5` | matches clarify | Five is the cap clarify already lives with; users rarely answer more than that thoughtfully anyway. |
| `notifications.slack/email: false` | both off | Local dev should not hit external services without the user opting in. |
| `notifications.timeoutHours: 2` | finite | Pause shouldn't hold a run forever. |

### Three layers, in order of precedence (highest wins)

```
1. pipeline-policy.overlay.json  (dashboard-managed, user clicks Save)
2. pipeline-policy.yaml           (power-user-authored, file on disk)
3. BUILTIN_DEFAULT_POLICY         (zero-config baseline)
```

`loadPolicy()` reads the yaml (or starts from the builtin if no yaml),
then layers the overlay on top. The overlay is shallow-merged at the
top level but deep-merged within `defaults` and `cost.limits`.

---

## 5. Schema additions

Two additions to `PipelinePolicy`:

```ts
// pipeline-policy-types.ts
export interface PipelinePolicy {
  version: string;
  /** Master switch for review pauses. Default true. When false, no pause ever fires. */
  enabled?: boolean;
  defaults: PolicyDefaults;
  paths: PathRule[];
  cost?: CostPolicy;
  notifications?: NotificationConfig;
  reviewers?: Array<{ match: string; users: string[] }>;
  /** Agent Q&A controls — applies to clarify/requirements/repo-requirements/specs stages. */
  qa?: AgentQuestionPolicy;
}

export interface AgentQuestionPolicy {
  /** Master toggle for Q&A across all planning stages. Default true. */
  enabled?: boolean;
  /** Hard cap on how many questions an agent may ask per stage. Default 5. */
  maxQuestionsPerStage?: number;
}
```

**`enabled` (review pauses):**
- Old yaml files (no `enabled` key) keep working as before — but they
  WERE working only when present. Their absence used to mean "off";
  now their presence means "on, with whatever they say".
- Old overlay files keep working (no `enabled` key → unchanged).
- New overlay writes from the dashboard SET `enabled` explicitly.

**`qa` (agent questions):**
- New field. Default `{ enabled: true, maxQuestionsPerStage: 5 }`.
- The list of *which* stages support Q&A is **hard-coded** in the
  runner (`['clarify', 'requirements', 'repo-requirements', 'specs']`)
  — not user-configurable in v1. This avoids tempting users to enable
  Q&A on `build` (a known anti-pattern; see §2 non-goals).
- Reused for clarify (which today silently caps at 5 inside
  `runClarifyForProject`); now the cap is policy-driven and consistent.

No other schema changes. The existing `defaults`, `cost`,
`notifications`, `paths`, `reviewers` blocks are reused as-is.

---

## 6. Server changes (file-by-file)

### 6.1 `packages/dashboard/server/pipeline-policy-types.ts`

Add `enabled?: boolean` to `PipelinePolicy` (line 42–49).

### 6.2 `packages/dashboard/server/pipeline-policy.ts`

**Change 1 (line 384, `loadPolicy`):** return the builtin default
when no yaml is found, instead of `null`.

```ts
export function loadPolicy(projectSlug: string, anvilHome?: string): PipelinePolicy {
  const home = anvilHome ?? defaultAnvilHome();
  const yamlPath = join(home, 'projects', projectSlug, 'pipeline-policy.yaml');

  let policy: PipelinePolicy;
  if (existsSync(yamlPath)) {
    const raw = readFileSync(yamlPath, 'utf-8');
    policy = shapePolicy(parseYaml(raw));
  } else {
    policy = BUILTIN_DEFAULT_POLICY;
  }

  // Layer dashboard-managed overlay on top.
  policy = applyOverlay(policy, projectSlug, home);
  return policy;
}
```

**Note the signature change:** `PipelinePolicy | null` → `PipelinePolicy`.
Three callers in `dashboard-server.ts` (lines 1215, 4465, 5165, 5279)
have null-checks (`if (!policy) return;`); each becomes a check on
`policy.enabled === false` instead. See §6.3.

**Change 2:** add `BUILTIN_DEFAULT_POLICY` const (already specified in §4).
Place near `defaultPolicy()` (lines 416–423) and replace the existing
`defaultPolicy()` body to return `BUILTIN_DEFAULT_POLICY` so any other
caller stays consistent.

**Change 3:** extend `applyOverlay` (split out of `loadPolicy` body
lines 392–411) to honour overlay `enabled`, `defaults`, and any other
top-level fields besides `cost`.

```ts
function applyOverlay(base: PipelinePolicy, projectSlug: string, home: string): PipelinePolicy {
  const overlayPath = join(home, 'projects', projectSlug, 'pipeline-policy.overlay.json');
  if (!existsSync(overlayPath)) return base;
  let overlay: Partial<PipelinePolicy>;
  try {
    overlay = JSON.parse(readFileSync(overlayPath, 'utf-8'));
  } catch {
    return base;
  }
  // Top-level scalars
  const out: PipelinePolicy = { ...base };
  if (typeof overlay.enabled === 'boolean') out.enabled = overlay.enabled;
  // Defaults — deep merge
  if (overlay.defaults) {
    out.defaults = {
      ...base.defaults,
      ...overlay.defaults,
    };
  }
  // Cost — keep existing deep-merge logic
  if (overlay.cost) {
    out.cost = {
      ...(base.cost ?? {}),
      ...overlay.cost,
      limits: { ...(base.cost?.limits ?? {}), ...(overlay.cost.limits ?? {}) },
    };
  }
  // Notifications — shallow merge
  if (overlay.notifications) {
    out.notifications = { ...(base.notifications ?? {}), ...overlay.notifications };
  }
  return out;
}
```

**Change 4 (line 425, `evaluatePolicy`):** add an early return when
`enabled === false`.

```ts
export function evaluatePolicy(policy: PipelinePolicy, input: PolicyEvaluationInput): PolicyDecision {
  if (policy.enabled === false) {
    return { pause: false, reason: 'disabled', matchedRules: [], reviewers: [] };
  }
  // ... existing logic unchanged
}
```

**LOC impact:** ~30 LOC added, ~5 LOC removed (the `null` return).
Net `pipeline-policy.ts`: +25 LOC.

### 6.3 `packages/dashboard/server/dashboard-server.ts`

**Three call sites, three small edits:**

| Line | Today | After |
|---|---|---|
| 1215 | `try { return loadPolicy(project, ANVIL_HOME); } catch { return null; }` | Drop the catch — `loadPolicy` no longer throws on missing file. Keep try/catch only for malformed yaml. |
| 4465 | `const policy = loadPolicy(project, ANVIL_HOME);` (returns null possible today) | `loadPolicy` always returns a value; remove any `if (!policy)` downstream. |
| 5165 | `if (!policy) return;` after `loadPolicy(...)` | Replace with `if (policy.enabled === false) return;` |
| 5279 | Same `if (!policy) return;` for cost hook | Same replacement. |

**`update-pipeline-policy` handler extension (line 4475–4517).**
Currently accepts `{ patch: { cost: {...} } }`. Extend to accept the
full overlay shape:

```ts
case 'update-pipeline-policy': {
  const { project, patch } = msg as {
    project?: string;
    patch?: {
      enabled?: boolean;
      defaults?: { pauseAfter?: PipelineStage[]; autoApproveIfRisk?: 'low' | 'med'; autoApproveIfConfidence?: number };
      cost?: { onBreach?: 'ask' | 'auto-approve' | 'auto-reject'; autoApproveBelow?: number; graceWindowSeconds?: number; limits?: { perRun?: number; perProjectDaily?: number; perStage?: Partial<Record<PipelineStage, number>> } };
      notifications?: { slack?: boolean; email?: boolean; timeoutHours?: number };
    };
  };
  if (!project || !patch) {
    ws.send(JSON.stringify({ type: 'pipeline-policy-error', payload: { message: 'project + patch required' } }));
    break;
  }
  // Validation guards (centralized in a helper):
  const validation = validatePolicyPatch(patch);
  if (!validation.ok) {
    ws.send(JSON.stringify({ type: 'pipeline-policy-error', payload: { message: validation.error } }));
    break;
  }
  // Read existing overlay → deep merge → write.
  const projDir = join(ANVIL_HOME, 'projects', project);
  if (!existsSync(projDir)) mkdirSync(projDir, { recursive: true });
  const overlayPath = join(projDir, 'pipeline-policy.overlay.json');
  const existing = existsSync(overlayPath) ? JSON.parse(readFileSync(overlayPath, 'utf-8')) : {};
  const merged = deepMergeOverlay(existing, patch);
  writeFileSync(overlayPath, JSON.stringify(merged, null, 2), 'utf-8');
  // Broadcast so any other open dashboard tab refreshes.
  broadcast({ type: 'pipeline-policy-saved', payload: { project, overlay: merged, effective: loadPolicy(project, ANVIL_HOME) } });
  ws.send(JSON.stringify({ type: 'pipeline-policy-updated', payload: { project, overlay: merged, effective: loadPolicy(project, ANVIL_HOME) } }));
  try { broadcastCostSnapshot(project); } catch { /* ok */ }
  break;
}
```

`validatePolicyPatch` lives in a new `packages/dashboard/server/pipeline-policy-validate.ts`:

- `enabled` must be boolean if present.
- `defaults.pauseAfter` items must be in `['plan','implement','review','test','ship']`.
- `defaults.autoApproveIfRisk` must be `'low' | 'med'`.
- `defaults.autoApproveIfConfidence` must be `0 ≤ x ≤ 1`.
- `cost.graceWindowSeconds` in `[10, 600]` (existing rule).
- `cost.autoApproveBelow ≥ 0` (existing rule).
- `cost.limits.perRun ≥ 0`, `perProjectDaily ≥ 0`.
- `notifications.timeoutHours` in `[0.25, 168]` (15 min – 1 week).

**Returns** `{ ok: true } | { ok: false; error: string }`.

`deepMergeOverlay` is a shallow-on-top + deep-merge-known-blocks
helper. ~40 LOC, kept in the same validate module.

**LOC impact:** ~80 LOC added in dashboard-server.ts (most of which is
the patch-shape destructuring); ~50 LOC in the new
`pipeline-policy-validate.ts`.

### 6.4 `packages/dashboard/server/pipeline-runner-types.ts`

Extend `PipelineStageState` and `RepoAgentState` to carry Q&A state:

```ts
export interface StageQuestion {
  index: number;            // 0-based position in the question list
  text: string;             // the agent's question
  answer?: string;          // undefined until user answers; trimmed string after
  answeredAt?: string;      // ISO timestamp
}

export interface PipelineStageState {
  // ... existing fields
  questions?: StageQuestion[];   // populated when the agent asks
}

export interface RepoAgentState {
  // ... existing fields
  questions?: StageQuestion[];   // per-repo Q&A for repo-requirements / specs
}
```

No other type changes. `PolicyEvaluationInput` and `PolicyDecision`
already support the gating data model.

### 6.5 `packages/dashboard/server/pipeline-stages.ts`

For policy-pause behavior, no change — `setAfterStageHook` already
invokes whatever the dashboard wires; the gating change happens
entirely on the server side via `evaluatePolicy`.

For Q&A, three changes:

1. **Switch `runSingleStage` (used by `requirements`) from
   `AgentManagerRunner` to `AgentManagerSession`** when Q&A is enabled
   for the project. The session-vs-runner branch is gated by
   `policy.qa?.enabled !== false`. When disabled, fall through to
   today's one-shot path so users on slow networks aren't penalised.

2. **Switch `runPerRepoStage` (used by `repo-requirements`, `specs`,
   `validate`) similarly** when the stage is in the Q&A scope list AND
   Q&A is enabled. `validate` is excluded from the scope list — it has
   its own fix-loop and shouldn't paste questions in.

3. **Add `runStageWithQA(opts)` helper** alongside the existing
   single/perRepo helpers. Mirrors `runClarifyForProject`'s shape but
   parameterised by stage name + max questions:

   ```ts
   export async function runStageWithQA(opts: {
     agentSession: AgentManagerSession;
     stageName: string;          // 'requirements' | 'specs' | …
     repoName?: string;
     project: string;
     workspaceDir: string;
     repoPath?: string;          // workingDir for the agent
     model: string;
     allowedTools: string[];
     maxOutputTokens: number;
     maxQuestions: number;       // from policy.qa.maxQuestionsPerStage
     projectPrompt: string;
     stagePrompt: string;        // the would-be one-shot prompt
     isCancelled: () => boolean;
     onAgentSpawned: (agentId: string) => void;
     onTruncation: (agentName: string, outputTokens: number) => void;
     onStageQuestion: (qIdx: number, total: number, question: string) => void;
     onWaitingForInput: (agentId: string) => void;
     onAnswerReceived: (qIdx: number, answer: string) => void;
     onSynthesizeStart: () => void;
     inputResolver: () => Promise<string>;  // resolves with the formatted answers block
   }): Promise<{ artifact: string; cost: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; questions: ReadonlyArray<{ text: string; answer: string }> }>;
   ```

   Implementation outline:
   - Injects a Q&A header into the stage prompt:
     > "If you need clarification before producing the artifact,
     > output ONLY the questions in this format and nothing else:
     > `<questions>` ... `</questions>`. List up to N questions, most
     > important first. If you're confident, produce the artifact
     > directly."
   - Calls `agentSession.start(...)` with the stage prompt.
   - Reads the first response. Uses a NEW
     `parseStageQuestions(text, maxQuestions)` parser (general-purpose
     version of `parseClarifyQuestions`) that extracts the
     `<questions>` block, splits by lines/numbering, caps at
     `maxQuestions`, and returns `[]` when no `<questions>` block is
     present (signal: agent is producing the artifact directly).
   - If parsed questions are non-empty: emit `onStageQuestion(...)`
     for each, then call `onWaitingForInput(...)`, then await
     `inputResolver()` to receive the formatted answers block. Send
     answers via `agentSession.sendInput(answersBlock)`. Read the
     follow-up response — that's the artifact.
   - If no questions: the first response IS the artifact. Just return
     it.
   - Returns the artifact + accumulated tokens + cost + the Q&A pair
     list (so the runner can persist them on
     `state.stages[i].questions`).

4. **`StageOpsDeps` extension** — add a single accessor for the Q&A
   policy + a per-repo answer-resolver registry:

   ```ts
   export interface StageOpsDeps {
     // ...existing fields
     getQAPolicy: () => AgentQuestionPolicy | undefined;
     /** Per-(stageIndex, repoName?) input resolvers for Q&A answers. */
     stageInputResolvers: Map<string, ((text: string) => void)>;  // key: `${stageIndex}|${repoName ?? '__'}`
     setStageInputResolver: (key: string, resolve: ((text: string) => void) | null) => void;
   }
   ```

   The runner stores resolvers per-(stage, repo) so per-repo fanout in
   `repo-requirements`/`specs` can have N concurrent question lists
   resolved independently.

5. **Persist Q&A history on stage state** when `runStageWithQA`
   returns. Mutate `deps.state.stages[i].questions` (or
   `repos[r].questions`). The Q&A pairs survive into the post-stage
   review modal as the read-only history disclosure (§7.6).

**LOC impact (server-side Q&A wiring):** ~250 LOC across:
- `pipeline-stages.ts`: +120 (new helper + branches)
- `pipeline-runner-types.ts`: +20 (StageQuestion type + state slot)
- `core-pipeline/src/stages/qa.ts` (new, optional — could host
  `parseStageQuestions` + the prompt header constant): +60
- Tests: +50

### 6.6 `packages/dashboard/server/dashboard-server.ts` — Q&A surface

**One new WS message family — `stage-question` (broadcast)** generalises
the existing `clarify-question`. Old `clarify-question` stays in place
as an alias for backward compatibility (frontend reads both during the
transition; v2 drops `clarify-question`).

**Update the `user-input` handler** so it routes per (stageIndex,
repoName?) to the right resolver. The current handler only handles
clarify (single-resolver). Extend to accept a payload like:

```ts
interface UserInputMsg {
  action: 'user-input';
  stageIndex: number;
  repoName?: string;        // for per-repo stages
  questionIndex: number;    // 0-based; identifies which question this answers
  text: string;
}
```

The handler calls `runner.provideStageAnswer(stageIndex, repoName ?? null, questionIndex, text)` (a new public method on `PipelineRunner` that:
  - Looks up the resolver via `key = ${stageIndex}|${repoName ?? '__'}`.
  - Records the answer onto `state.stages[i].questions[questionIndex]` (or per-repo).
  - Broadcasts `state-change`.
  - When all questions for that key have answers, formats them as an
    `<answers>` block and resolves the agent's input promise.).

**Two new WS broadcasts:**
- `stage-question` (per question per stage):
  ```ts
  { type: 'stage-question', payload: {
      stageIndex: number;
      stageName: string;
      repoName?: string;
      questionIndex: number;
      totalQuestions: number;
      question: string;
  }}
  ```
- `stage-answer-recorded` (after user answers one question):
  ```ts
  { type: 'stage-answer-recorded', payload: {
      stageIndex: number;
      repoName?: string;
      questionIndex: number;
      remaining: number;     // unanswered count
  }}
  ```

**LOC impact:** ~80 LOC in `dashboard-server.ts` (new handler + 2 new
broadcasts + the `provideStageAnswer` plumbing).

---

## 7. Frontend changes

### 7.1 New route: `/policy`

`packages/dashboard/src/main.tsx` (or wherever routes are declared) —
add a new route + sidebar entry.

- Sidebar order proposal: Home → Active Runs → **Policy** → Plans →
  Tests → Knowledge → Settings.
- Icon: shield (lucide `shield-check` or equivalent in existing icon
  set).

### 7.2 New component tree

```
src/components/policy/
├── PolicyPage.tsx                 # top-level route component
├── policy-copy.ts                 # all UI strings (see §3)
├── usePolicy.ts                   # hook: load + save state, WS plumbing
├── policy-deep-equal.ts           # change-detection helper
├── PolicyMasterSwitch.tsx         # the on/off toggle + confirmation
├── PolicyPauseAfter.tsx           # 5 stage checkboxes + hints
├── PolicyAutoApprove.tsx          # risk radio + confidence slider
├── PolicyCostPanel.tsx            # per-run / daily / per-stage / breach
├── PolicyNotifications.tsx        # slack/email/timeout
├── PolicyPathRulesReadOnly.tsx    # static rendering of yaml.paths
└── __tests__/
    ├── PolicyPage.test.tsx
    └── usePolicy.test.tsx
```

### 7.3 `usePolicy` hook contract

```ts
export interface PolicyHook {
  // Server's effective policy (yaml + overlay + builtin merged) — read-only.
  effective: PipelinePolicy | null;
  // The overlay JSON as last loaded — dashboard-editable surface.
  overlay: Record<string, unknown> | null;
  // Local form state — diverges from `overlay` until Save fires.
  form: PolicyFormState;
  // Whether form differs from overlay — drives Save button enable.
  dirty: boolean;
  // Whether the last save round-tripped — drives toast + status pill.
  status: 'idle' | 'saving' | 'saved' | 'error';
  // Last error message (if status === 'error').
  error: string | null;

  // Mutators
  setEnabled(v: boolean): void;
  setPauseAfter(stages: PipelineStage[]): void;
  setAutoApproveRisk(v: 'low' | 'med' | 'never'): void;
  setAutoApproveConfidence(v: number): void;
  setCost(p: Partial<PolicyFormState['cost']>): void;
  setNotifications(p: Partial<PolicyFormState['notifications']>): void;
  reset(): void;             // form ← overlay
  save(): Promise<void>;     // overlay ← form via WS
}
```

Implementation: subscribes to WS `pipeline-policy` (load) +
`pipeline-policy-saved` / `pipeline-policy-updated` / `pipeline-policy-error`
(broadcast). Sends `get-pipeline-policy` on mount + on project change.
Sends `update-pipeline-policy` on Save.

### 7.4 Settings page change

`packages/dashboard/src/components/settings/SettingsPage.tsx:219`:
replace the "Coming soon" block with a single link/button:

```tsx
<SettingRow
  title="Pipeline policy & cost"
  description="Decide when Anvil pauses for review and how it spends. Open the dedicated Policy page."
>
  <Button onClick={() => navigate('/policy')}>Open Policy</Button>
</SettingRow>
```

### 7.5 `PausedBanner` link to `/policy`

`PausedBanner.tsx` already shows when a pause is live. Add a small
"Why am I seeing this?" link → `/policy?project=<slug>` so first-time
users discover the page from the very first pause.

### 7.6 Stage card — `StageQuestionsPanel`

When a stage is in the Q&A waiting state, the stage card grows a
panel listing the agent's questions inline. New component:

```
src/components/pipeline/
├── StageQuestionsPanel.tsx
└── __tests__/StageQuestionsPanel.test.tsx
```

**Render condition:** the panel mounts when
`state.stages[i].questions?.length > 0` AND any have
`answer === undefined`. After every question is answered, the panel
collapses into a "Q&A history (N questions answered)" disclosure that
sits on the stage card while the agent resumes.

**Layout (one row per question):**

```
┌── Stage card: Requirements ───────────────────────────────┐
│ Status: ▷ waiting for your answers (3 questions)          │
│ Agent: <agent-id-short>                                   │
│                                                            │
│ ┌── Question 1 of 3 ──────────────────────────────────┐  │
│ │ Should the booking flow support guest checkout, or  │  │
│ │ require a logged-in user?                            │  │
│ │ ┌──────────────────────────────────────────────────┐│  │
│ │ │ Guest checkout for browsing; force login on the   ││  │
│ │ │ payment step.                                      ││  │
│ │ └──────────────────────────────────────────────────┘│  │
│ │                                          [ Submit ] │  │
│ └────────────────────────────────────────────────────┘  │
│                                                            │
│ ┌── Question 2 of 3 ──────────────────────────────────┐  │
│ │ ✓ Answered: …trimmed snippet… [Edit]                 │  │
│ └────────────────────────────────────────────────────┘  │
│                                                            │
│ ┌── Question 3 of 3 ──────────────────────────────────┐  │
│ │ … (textarea + Submit, same as Q1)                   │  │
│ └────────────────────────────────────────────────────┘  │
│                                                            │
│ [ Submit all answers ]   ← enabled when every Q has text  │
└────────────────────────────────────────────────────────────┘
```

**Submit semantics:**
- Per-question Submit fires a single
  `{ action: 'user-input', stageIndex, repoName?, questionIndex, text }`.
  Server records the answer + broadcasts `stage-answer-recorded`. The
  row collapses into the "✓ Answered" state with an Edit button.
- "Submit all answers" is a convenience that fires one WS per
  unanswered question rapid-fire.
- The panel disables individual Submit buttons after click until the
  `stage-answer-recorded` broadcast lands (optimistic UX with
  rollback on error).
- Once every question is answered, the agent resumes automatically
  (server-side, when `provideStageAnswer` records the last one).

**Per-repo stages** (repo-requirements / specs): each repo's card has
its own `StageQuestionsPanel`. The `RepoBreakdownList` already
supports expand/collapse per repo; the panel renders inside the
expanded section.

**Edit-after-answer:**
- Clicking Edit on an answered question reopens the textarea with the
  prior text. Submit replaces the prior answer. ONLY allowed before
  the agent has resumed (i.e. before the LAST question is answered).
  After resume, edits are no-ops with a toast: "Stage already resumed
  — to revise, use rerun-from on the stage card."

### 7.7 Review modal — Q&A history disclosure

`PlanReviewModal.tsx` gets a small addition: above the artifact
preview, render a collapsed disclosure when
`state.stages[stageIndex].questions?.length > 0`:

```
▶ Q&A from this stage (3 answered questions)
```

Clicking expands it inline. Each Q/A pair renders as:

```
Q: Should the booking flow support guest checkout?
A: Guest checkout for browsing; force login on payment.
```

For per-repo stages, the disclosure also shows per-repo headers:

```
▶ Q&A from this stage
   ▼ web (2 answered)
     Q: …    A: …
   ▼ ui (1 answered)
     Q: …    A: …
```

State source: same `state.stages[stageIndex].questions` /
`state.stages[stageIndex].repos[r].questions` already populated by the
runner. No new server work — purely a frontend render.

### 7.8 Read-only Q&A history on completed stages

After a stage completes (with or without Q&A), the stage card should
keep a permanent "Q&A history (N answered questions)" disclosure for
historical context. Reuses the same component as §7.6's collapsed
state.

---

## 8. WS message contracts

Three messages, all already exist in name. Two get extended.

### `get-pipeline-policy` (unchanged)

**Request:** `{ action: 'get-pipeline-policy', project: string }`

**Response:** `{ type: 'pipeline-policy', payload: { project, policy: PipelinePolicy, overlay: Record<string, unknown> | null } }`

The `policy` field now contains the BUILTIN_DEFAULT_POLICY when no
yaml exists — and is therefore always defined. Frontend can drop
defensive null-checks.

### `update-pipeline-policy` (extended)

**Request:**
```ts
{
  action: 'update-pipeline-policy',
  project: string,
  patch: {
    enabled?: boolean,
    defaults?: { pauseAfter?: PipelineStage[]; autoApproveIfRisk?: 'low'|'med'; autoApproveIfConfidence?: number },
    cost?: { onBreach?: 'ask'|'auto-approve'|'auto-reject'; autoApproveBelow?: number; graceWindowSeconds?: number; limits?: {...} },
    notifications?: { slack?: boolean; email?: boolean; timeoutHours?: number }
  }
}
```

**Response (success):** `{ type: 'pipeline-policy-updated', payload: { project, overlay, effective: PipelinePolicy } }`

**Response (validation fail):** `{ type: 'pipeline-policy-error', payload: { message: string } }`

### `pipeline-policy-saved` (NEW broadcast)

Fired AFTER a successful save so other open dashboard tabs (or the
PausedBanner reading the `effective` policy) refresh. Same payload as
`pipeline-policy-updated`. Subscribers: `usePolicy` hook on every
mounted Policy page, plus the cost meter.

### `stage-question` (NEW broadcast — generalises `clarify-question`)

```ts
{
  type: 'stage-question',
  payload: {
    stageIndex: number;
    stageName: string;        // 'clarify' | 'requirements' | 'repo-requirements' | 'specs'
    repoName?: string;        // present for per-repo stages
    questionIndex: number;    // 0-based
    totalQuestions: number;
    question: string;
  }
}
```

Both `clarify-question` AND `stage-question` are broadcast for the
clarify stage during the transition window so existing UI keeps
working. Frontend reads whichever; new UI reads `stage-question`. After
two release cycles, drop the `clarify-question` alias.

### `stage-answer-recorded` (NEW broadcast)

Fired after the server records the user's answer for one question.
Lets the UI optimistically transition the row to "✓ Answered" the
moment the round-trip lands.

```ts
{
  type: 'stage-answer-recorded',
  payload: {
    stageIndex: number;
    repoName?: string;
    questionIndex: number;
    remaining: number;        // unanswered count for this (stage, repo)
  }
}
```

### `user-input` (extended request shape)

```ts
{
  action: 'user-input',
  stageIndex: number;
  repoName?: string;          // NEW — for per-repo Q&A
  questionIndex: number;      // NEW — identifies which question this answers
  text: string;
}
```

The clarify stage today sends `{ action: 'user-input', stageIndex, text }`
with no question index (it answers a single in-flight question at a
time). The new shape is backward-compatible — when `questionIndex` is
omitted, the server treats it as the FIRST unanswered question of the
named stage, which matches today's clarify semantics.

---

## 9. Migration / rollout

### What changes the moment this ships

| User scenario | Before | After |
|---|---|---|
| Project with `pipeline-policy.yaml` (active) | Pauses fire per yaml | Pauses fire per yaml + overlay layered on top. Behavior unchanged for projects that already had a yaml — the overlay starts empty. |
| Project with `pipeline-policy.yaml.bak` (renamed) | No pauses (yaml ignored) | Pauses fire per BUILTIN_DEFAULT_POLICY. **First-time pause after Plan stage on the next run.** |
| Brand new project (no yaml) | No pauses | Pauses fire per BUILTIN_DEFAULT_POLICY. Same as `.bak` case. |
| Project where user explicitly disabled via overlay | Was no path to disable from UI today | Master switch off → overlay `{ enabled: false }` → `evaluatePolicy` returns `{ pause: false, reason: 'disabled' }`. |
| Project running `clarify` for the first time after upgrade | Q&A worked (existing behavior) | Q&A still works; behavior unchanged. The cap respects `policy.qa.maxQuestionsPerStage` instead of the previous hard-coded value, but the default is the same (5). |
| Project running `requirements` or `specs` for the first time after upgrade | One-shot agent → artifact | Agent MAY choose to ask up to 5 questions (default cap). Card shows the question panel inline. If the agent is confident, no questions, behavior is identical to before. **First-time surprise:** users who have only ever seen one-shot requirements may now see questions. |

### Migration step (silent — no user action required)

None. The feature activates the moment the user updates the dashboard
binary. The first run after upgrade pauses after Plan unless the user
turns it off via `/policy`.

### User comms to add

- **First-run-after-upgrade banner** on the dashboard home: a single
  dismissible banner reading
  > "Anvil now pauses for review after each plan. Manage in Policy."
  Banner sets `localStorage.policyDefaultOnNoticeSeen = '1'` on
  dismiss. Show once per browser, ever.
- **Release note in the README + changelog** listing this as a behavior
  change with the master-toggle escape hatch.

---

## 10. Edge cases

| Case | Handling |
|---|---|
| Yaml has `defaults: { pauseAfter: [] }` (explicit no-pause) | Honoured. Master switch shows ON, but pauseAfter checkboxes show none ticked. User sees "Pauses are on but no stage triggers them" — copy hint added below the checkbox group when count is 0. |
| Yaml has `pauseAfter: ['plan']` AND overlay sets `pauseAfter: ['plan', 'implement']` | Overlay wins. Effective = `['plan', 'implement']`. |
| Master switch off in overlay (`enabled: false`), yaml has every stage gated | `evaluatePolicy` returns `disabled` early. No pauses. The user wins. |
| Concurrent saves from two tabs | Last-write-wins on the file. The `pipeline-policy-saved` broadcast fans out so the loser tab sees the winner's overlay on next mount; if mid-edit, banner: "Settings changed in another tab. Refresh?" with a Refresh button that reloads `effective` + form. |
| Overlay JSON malformed | `applyOverlay` swallows + returns base policy. Dashboard surfaces the issue via a yellow inline notice on the Policy page: "Overlay file unreadable; using yaml/defaults only. Click Reset to overwrite." Reset button truncates the overlay and re-saves form state. |
| Cost limit set to 0 | Allowed but warned: "0 means every run pauses on first cent. Use master toggle to disable cost gating instead." |
| `pauseAfter` includes a stage not in `VALID_STAGES` | Validator rejects with a specific error: "Unknown stage: foo". |
| User toggles master OFF mid-run | Doesn't cancel the live pause if one is already in `pauseStore`. Pause UI still shows; only future stages skip the gate. Status pill on `/policy` reads "Off — current run will finish under previous settings". |
| yaml file has `version: 2.0.0` (future) | Schema version mismatch — server logs a warning, treats as 1.0.0. Path-rules UI shows a yellow banner: "Yaml uses an unrecognized schema version. Update Anvil." |
| Project has no `~/.anvil/projects/<slug>/` directory | `update-pipeline-policy` creates it with `mkdirSync recursive`. Already implemented — preserved. |
| A run is paused but the user navigates to `/policy`, toggles master OFF, saves | Live pause is unaffected (see above). User still resolves the modal manually. Future runs skip the gate. |
| User edits yaml directly while overlay is also set | Yaml change takes effect on next `loadPolicy` call. Overlay still wins per precedence. Dashboard's "Rules from yaml" panel reflects the new yaml on next page load. |
| Agent emits malformed `<questions>` block (e.g. open tag, no close) | `parseStageQuestions` returns `[]` (no questions extracted). The agent's output is treated as the artifact. If it doesn't look like an artifact (e.g. empty / gibberish), the existing empty-artifact retry kicks in. |
| Agent claims to have N questions but `<questions>` block contains M ≠ N entries | Use `M` (parsed value). Don't trust the agent's self-count. |
| Agent emits MORE than `maxQuestionsPerStage` | Truncate to first N. Log a warning project-event: "Agent asked X questions; capped at Y". |
| User answers some questions, refreshes the page mid-Q&A | Q&A state is in `state.stages[i].questions` and persisted by the existing `checkpoint()` write. On reload, the answered ones show "✓ Answered"; unanswered ones still have the textarea. The agent is still waiting on its in-memory `inputResolver`; if the dashboard restarts, the resolver is gone — see next row. |
| Dashboard restart while agent is in mid-Q&A wait | Hard case. The `agentSession` is in-memory; if the dashboard process dies, the session is lost. Recovery: on next start, the runner reads the checkpoint; if `state.stages[i].status === 'waiting'` AND `questions` are partially answered, mark the stage `failed` with reason "session lost during Q&A; rerun from this stage". User clicks rerun-from to restart the stage with no Q&A. v1 acceptance — durable Q&A is a Pattern-2 problem (see core-pipeline ADR). |
| Agent asks a question with HTML-looking text | The textarea + display escape via React's default escaping. No XSS risk. Same handling as clarify today. |
| Per-repo fanout: 3 repos, all 3 agents ask questions | All three render in their own repo cards. Each is independently answerable. Only when ALL three repos have all their questions answered does any of them resume the agent — wait, no, they're independent. Each per-repo agent resumes as soon as ITS questions are all answered. |
| Q&A enabled in policy, but stage not in scope (e.g. `tasks`) | Stage runs as today (one-shot). The scope list is hard-coded server-side. |
| Q&A disabled in policy | All planning stages run as one-shot. The agent prompts don't include the Q&A header (saves prompt bytes). |

---

## 11. Test plan

### Server-side unit tests

- `pipeline-policy.test.ts` (extend existing):
  - `loadPolicy` with no yaml → returns `BUILTIN_DEFAULT_POLICY`.
  - `loadPolicy` with yaml only → yaml wins.
  - `loadPolicy` with overlay only → builtin + overlay merged.
  - `loadPolicy` with yaml + overlay → all three layers merged with
    correct precedence.
  - `evaluatePolicy` with `enabled: false` → `{ pause: false, reason: 'disabled' }`.
  - `evaluatePolicy` with `enabled: true` and stage in pauseAfter → pause: true.

- `pipeline-policy-validate.test.ts` (new):
  - Each invalid patch shape returns `{ ok: false, error: <expected> }`.
  - Valid patches return `{ ok: true }`.
  - `deepMergeOverlay` merges existing + new without dropping fields.

- `dashboard-server.policy-handlers.test.ts` (new — uses the existing
  ws-mock harness pattern):
  - `update-pipeline-policy` with valid `enabled` patch writes the
    overlay file with `{ enabled: false }`.
  - `update-pipeline-policy` with invalid `defaults.pauseAfter`
    responds `pipeline-policy-error`.
  - `update-pipeline-policy` broadcasts `pipeline-policy-saved` to all
    subscribers.
  - `setAfterStageHook` short-circuits when `policy.enabled === false`
    (no `pauseStore.pause` call).

### Frontend unit tests

- `usePolicy.test.tsx`:
  - Mount → sends `get-pipeline-policy`. Receives → form populated
    with overlay overlaid on effective.
  - `setEnabled(false)` → form.dirty = true.
  - `save()` → sends `update-pipeline-policy`. On
    `pipeline-policy-updated` → status = 'saved', overlay updated,
    dirty = false.
  - `pipeline-policy-error` → status = 'error', error message stored,
    save button re-enabled.

- `PolicyPage.test.tsx`:
  - Renders all five sections.
  - Master switch off greys out stage checkboxes + auto-approve panel.
  - Cost panel stays interactive when master is off.
  - Save button disabled when form === server.
  - Confirmation modal blocks save when toggling master off.

### Q&A unit tests (server)

- `parseStageQuestions.test.ts` (new):
  - `<questions>1. foo\n2. bar</questions>` → `['foo', 'bar']`.
  - No `<questions>` block → `[]`.
  - Malformed (open tag, no close) → `[]`.
  - 7 questions with `maxQuestions: 5` → first 5 returned.
  - Empty `<questions></questions>` → `[]`.
- `pipeline-stages.qa.test.ts` (new — uses agent-session mocks):
  - `runStageWithQA` — agent confident path: first response is the
    artifact, no questions emitted, no input awaited.
  - `runStageWithQA` — Q&A path: first response is questions,
    `onStageQuestion` fires N times, `onWaitingForInput` fires,
    `inputResolver` resolves with answers block, second response is
    the artifact.
  - Q&A disabled in policy: prompt does NOT include Q&A header,
    behaviour identical to one-shot.
  - Q&A enabled but `maxQuestions === 0`: header omitted; one-shot.

### Q&A unit tests (frontend)

- `StageQuestionsPanel.test.tsx`:
  - Renders one row per unanswered question.
  - Per-question Submit fires WS with correct payload.
  - Optimistic transition on `stage-answer-recorded`.
  - "Submit all answers" enabled only when every textarea has text.
  - Edit-after-answer reopens textarea.
  - Per-repo variant: panel renders inside RepoBreakdownList expanded
    section.
- `PlanReviewModal.test.tsx` (extend):
  - Q&A disclosure renders when `questions?.length > 0`.
  - Per-repo Q&A history nests correctly.

### Integration: parity probe (cumulative — after all phases land)

End-to-end manual smoke:
1. Delete `~/.anvil/projects/pet-company/pipeline-policy.yaml.bak`'s
   sibling `.yaml` if any, ensure no overlay.
2. Start a `pet-company` run from the dashboard.
3. Confirm `pipeline-paused` arrives after Plan; modal appears;
   approve.
4. Toggle master OFF in `/policy`; start another run; confirm no pause
   fires.
5. Re-enable master + Q&A; start a fresh feature where the spec is
   ambiguous ("build a booking flow"). Confirm requirements stage
   shows N questions in the card; answer them; confirm artifact is
   produced.
6. Open the post-stage review modal; confirm Q&A history disclosure
   shows what was asked + answered.
7. Toggle Q&A OFF; rerun from requirements; confirm one-shot
   behaviour returns.

---

## 12. Phased delivery (commit-by-commit)

### Phase A — Server: default-on (one commit, ~150 LOC across 4 files)

1. `pipeline-policy-types.ts`: add `enabled?: boolean`.
2. `pipeline-policy.ts`: add `BUILTIN_DEFAULT_POLICY`, refactor
   `loadPolicy` to return non-null, split out `applyOverlay`, add
   `enabled` short-circuit in `evaluatePolicy`.
3. `dashboard-server.ts`: update three callers to use
   `policy.enabled === false` instead of null check.
4. `pipeline-policy.test.ts`: add 6 cases covering builtin, layering,
   enabled short-circuit.

**Test contract green:** existing 511/518 dashboard + 340/340
core-pipeline.

### Phase B — Server: extend update-pipeline-policy (one commit, ~150 LOC)

1. New file `pipeline-policy-validate.ts` (~80 LOC) with
   `validatePolicyPatch` + `deepMergeOverlay` + tests.
2. `dashboard-server.ts`: rewrite `update-pipeline-policy` handler;
   add `pipeline-policy-saved` broadcast; broaden patch type.
3. New file `pipeline-policy-validate.test.ts` (~80 LOC).
4. New file `dashboard-server.policy-handlers.test.ts` extending
   `update-pipeline-policy` cases.

**Test contract green** + 4 new test cases passing.

### Phase C — Frontend: `/policy` page (one commit, ~600 LOC)

1. `policy-copy.ts` (every string).
2. `usePolicy.ts` (~120 LOC).
3. `policy-deep-equal.ts` (~30 LOC).
4. Six panel components (~80 LOC each → ~480 LOC).
5. `PolicyPage.tsx` (~60 LOC) composes panels.
6. Route registration + sidebar entry in `main.tsx` (~10 LOC).
7. `usePolicy.test.tsx` + `PolicyPage.test.tsx` (~150 LOC).

**Test contract green** + new RTL tests.

### Phase D — Polish (one commit, ~80 LOC)

1. `SettingsPage.tsx`: replace "Coming soon" with link to `/policy`.
2. `PausedBanner.tsx`: add "Why am I seeing this?" link.
3. First-run-after-upgrade banner on home page (`localStorage`-gated).
4. README + CHANGELOG note.

**Test contract green.**

### Optional Phase E — Path rules read-only (one commit, ~120 LOC)

If we want the `Rules from yaml (read-only)` panel populated rather
than just labelled "advanced":

1. `usePolicy` exposes `effective.paths`.
2. `PolicyPathRulesReadOnly.tsx` renders the table.
3. Empty state copy.

Defer if scope balloons; not blocking phase A–D.

### Phase F — Q&A backend (one commit, ~330 LOC)

Server-side support for agents asking questions in
`requirements`/`repo-requirements`/`specs`. Clarify continues to work
unchanged in this phase (uses its own session helper); Phase G unifies
the prompt + parser.

1. New `core-pipeline/src/stages/qa.ts` with
   `parseStageQuestions(text, max)` + Q&A prompt header constant +
   tests (~80 LOC).
2. `pipeline-runner-types.ts`: add `StageQuestion` type +
   `questions?: StageQuestion[]` on `PipelineStageState` + on
   `RepoAgentState` (~20 LOC).
3. `pipeline-stages.ts`: new `runStageWithQA(opts)` helper modelled on
   `runClarifyForProject` (~120 LOC). Branch in `runSingleStage` and
   `runPerRepoStage` to use it when the stage is in scope AND Q&A is
   enabled in policy.
4. `pipeline-stages.ts`: `StageOpsDeps` extension — add
   `getQAPolicy()` + `stageInputResolvers` Map +
   `setStageInputResolver` (~15 LOC).
5. `pipeline-runner.ts`: new public method `provideStageAnswer(...)`
   (~25 LOC). Records answer, broadcasts `stage-answer-recorded`,
   resolves agent input promise when complete.
6. `dashboard-server.ts`: extend `user-input` handler;
   add `stage-question` + `stage-answer-recorded` broadcasts;
   keep `clarify-question` alias for backward compat (~70 LOC).
7. Tests (~50 LOC across `parseStageQuestions.test.ts` +
   `pipeline-stages.qa.test.ts`).

**Test contract green** + new tests passing.

### Phase G — Q&A frontend (one commit, ~400 LOC)

1. `StageQuestionsPanel.tsx` (~150 LOC) + tests (~80 LOC).
2. Mount the panel inside the existing stage card component (single
   integration site; ~20 LOC).
3. Mount the per-repo variant inside `RepoBreakdownList` expanded
   section (~20 LOC).
4. `PlanReviewModal.tsx`: add Q&A history disclosure above the
   artifact preview (~50 LOC).
5. WS subscriber for `stage-question` + `stage-answer-recorded` in
   the existing pipeline-state store (~30 LOC).
6. Update tests for the modal to cover the disclosure (~50 LOC).

**Test contract green** + new RTL tests.

### Phase H — Q&A unification with clarify (one commit, ~150 LOC)

Optional but recommended. Today clarify uses its own
`runClarifyForProject` helper with a custom Q&A loop. After Phase F
lands, refactor clarify to use `runStageWithQA` so there's one Q&A
implementation everywhere. Drop `clarify-question` alias and
`onClarifyQuestion` callback shape; emit `stage-question` only.

1. `pipeline-stages.ts:runClarifyStage` switches to `runStageWithQA`
   with stage-specific prompts (~40 LOC).
2. Delete `clarify-question` broadcast in `dashboard-server.ts` after
   confirming no frontend reads it (~10 LOC).
3. Drop `parseClarifyQuestions` in favour of `parseStageQuestions`
   (~20 LOC).
4. Update tests (~60 LOC).

Defer to a v2 cycle if you want to stage the cutover. Phase F+G alone
ships the user-visible feature.

---

## 13. Risks + open questions

### Risks

- **Behavior change for every user.** The default flips from "off" to
  "on". The first-run banner + master toggle are the mitigation; the
  release note documents it. **If this lands quietly without comms,
  users running `pet-company` without their `.bak` policy will get a
  surprise pause.**
- **Overlay precedence vs yaml is non-obvious.** Power users editing
  yaml might wonder why their changes don't take effect when an
  overlay is set. Mitigation: yellow notice on the Policy page when
  yaml + overlay both exist with conflicting fields, listing which
  yaml fields are being shadowed.
- **Cost defaults ($10/run, $30/day) may be wrong for some users.**
  They're conservative for demos, possibly too tight for production
  workloads. Mitigation: the Policy page exposes them with explanation
  on day one; users can raise them in two clicks.
- **Q&A friction on confident agents.** If models reliably opt out of
  Q&A when confident, this is fine. But some models will over-ask
  ("here are 7 questions about a one-line bug fix"). The
  `maxQuestionsPerStage` cap mitigates volume but not quality.
  Mitigation: tune the Q&A prompt header (in
  `core-pipeline/src/stages/qa.ts`) to bias toward "ask only when a
  reasonable engineer would refuse to start without an answer". Test
  empirically against the dashboard's own pet-company / space-company
  fixtures during development.
- **Q&A breaks resume across dashboard restart.** See §10's edge-case
  table. v1 acceptance: rerun-from. A v2 plan should make Q&A state
  durable (Pattern-2 problem, durable execution work in core-pipeline).
- **Per-repo Q&A volume.** With 3 repos in `specs`, the user could
  see 15 questions on one screen. UI should handle this — each repo
  card collapses by default; only the active repo's panel is open.

### Open questions (decide before merging)

1. **First-run banner timing.** Show on dashboard reload after upgrade
   (unconditional), OR show on first paused run? Banner-on-paused is
   subtler but ties the surprise to the moment it happens.
2. **Reset overlay** action — surfaced as a button on the page, or
   only via the conflict-state notice? Recommend: button in a
   "Danger zone" disclosure at the bottom of `/policy` so users can
   wipe their dashboard-managed settings without touching files.
3. **Policy page during an active run.** Allow edits or read-only?
   Recommend: allow edits with a notice "Changes apply to future runs;
   current run continues under loaded settings."
4. **Sidebar icon + label.** "Policy" or "Pauses & cost" or "Reviews"?
   Recommend: "Policy" — matches the file name + the team's existing
   vocabulary in `pipeline-policy.yaml`.
5. **Q&A scope override.** Should the policy schema allow narrowing
   Q&A to a subset of planning stages (e.g. "only `requirements`,
   never `clarify`")? Recommend: NO for v1. Keep it global. Users who
   want to opt clarify out can disable Q&A entirely + lean on the
   existing `skipClarify` config for the unconditional skip path.
6. **Per-question timeout.** Should an unanswered question auto-cancel
   after N hours (matching `notifications.timeoutHours`)? Recommend:
   YES — reuse the existing timeout. After `timeoutHours`, mark the
   stage failed with reason "Q&A timed out; no human response". Users
   rerun-from. This prevents hung sessions from holding agent state
   forever.
7. **Edit-after-resume.** Can the user edit an answer after the agent
   has already used it to produce the artifact? Recommend: NO — show
   a toast directing them to rerun-from. Editing past answers without
   re-running the stage produces a Q&A history that doesn't match the
   artifact.

---

## 14. Pre-flight contract before each commit

```sh
# Server contract
npm -w @esankhan3/anvil-core-pipeline test
npx tsc -p packages/dashboard/server/tsconfig.json
node --test packages/dashboard/server/out/__tests__/*.test.js   # ≥ 511 pass / 7 fail (baseline)

# Frontend contract
npm -w @anvil-dev/dashboard run build
# Vite build must succeed clean (no warnings beyond chunk-size)

# Cli build sanity
npm -w @esankhan3/anvil-cli run build
```

---

## 15. LOC summary (predicted)

### Policy work (Phases A–D)

| File | Δ |
|---|---:|
| `packages/dashboard/server/pipeline-policy-types.ts` | +5 |
| `packages/dashboard/server/pipeline-policy.ts` | +25 |
| `packages/dashboard/server/dashboard-server.ts` | +60 |
| `packages/dashboard/server/pipeline-policy-validate.ts` | +80 (new) |
| `packages/dashboard/server/__tests__/*.test.ts` (policy) | +200 (new) |
| `packages/dashboard/src/components/policy/*.tsx + *.ts` | +700 (new) |
| `packages/dashboard/src/components/policy/__tests__/*.test.tsx` | +150 (new) |
| `packages/dashboard/src/main.tsx` | +15 |
| `packages/dashboard/src/components/settings/SettingsPage.tsx` | −10 / +15 |
| `packages/dashboard/src/components/pipeline/PausedBanner.tsx` | +5 |
| `README.md` + `CHANGELOG.md` | +20 |

**Policy subtotal: ~1,250 LOC across 4 commits (A–D).**

### Q&A work (Phases F–G, optionally H)

| File | Δ |
|---|---:|
| `packages/core-pipeline/src/stages/qa.ts` | +60 (new) |
| `packages/core-pipeline/src/__tests__/parseStageQuestions.test.ts` | +60 (new) |
| `packages/dashboard/server/pipeline-runner-types.ts` | +20 |
| `packages/dashboard/server/pipeline-stages.ts` | +130 |
| `packages/dashboard/server/pipeline-runner.ts` | +25 |
| `packages/dashboard/server/dashboard-server.ts` | +70 |
| `packages/dashboard/server/__tests__/pipeline-stages.qa.test.ts` | +80 (new) |
| `packages/dashboard/src/components/pipeline/StageQuestionsPanel.tsx` | +150 (new) |
| `packages/dashboard/src/components/pipeline/__tests__/StageQuestionsPanel.test.tsx` | +80 (new) |
| `packages/dashboard/src/components/pipeline/PlanReviewModal.tsx` | +50 |
| `packages/dashboard/src/components/pipeline/StageCard.tsx` (or wherever) | +20 |
| `packages/dashboard/src/components/pipeline/RepoBreakdownList.tsx` | +20 |
| WS subscriber wiring (existing pipeline-state store) | +30 |

**Q&A subtotal: ~795 LOC across 2 commits (F–G), +150 if Phase H lands.**

### Total

**Policy + Q&A: ~2,045 LOC across 6 commits.** Test:non-test ratio
≈ 570 / 2045 = ~28%, in line with the rest of the dashboard. With
Phase H: ~2,195 LOC across 7 commits.

---

## 16. Ready-to-execute checklist

### Policy (Phases A–D)

- [ ] Confirm sidebar label ("Policy" assumed) + icon (`shield-check`).
- [ ] Confirm cost defaults (`$10/run`, `$30/day`) match the team's
      mental model OR get the user to override before merge.
- [ ] Phase A landed + dashboard tests green.
- [ ] Phase B landed + new validator tests green.
- [ ] Phase C landed + RTL tests green.
- [ ] Phase D landed + manual smoke (the §11 integration probe steps
      1–4).
- [ ] First-run banner visible after a fresh upgrade.
- [ ] README + CHANGELOG note merged.
- [ ] Manually: delete a project's yaml + overlay → confirm
      `BUILTIN_DEFAULT_POLICY` activates → confirm pause modal
      appears after Plan.

### Q&A (Phases F–G, optionally H)

- [ ] Confirm Q&A scope list (`['clarify', 'requirements',
      'repo-requirements', 'specs']`) and that build/test/validate
      stay one-shot.
- [ ] Confirm `maxQuestionsPerStage: 5` matches what feels right in
      practice (tune via the prompt header if agents over-ask in
      testing).
- [ ] Phase F landed + `parseStageQuestions` tests green +
      `pipeline-stages.qa.test.ts` green.
- [ ] Phase G landed + `StageQuestionsPanel` tests green + modal Q&A
      disclosure renders.
- [ ] Manual smoke: ambiguous feature ("build a booking flow") on a
      project with Q&A enabled — confirm requirements stage shows
      questions in the card, answers route to the right resolver,
      artifact reflects the answers.
- [ ] Manual smoke: same feature with Q&A disabled in policy —
      confirm one-shot artifact, no questions.
- [ ] Manual smoke: review modal opens after a stage with Q&A
      history — confirm disclosure shows Q/A pairs.
- [ ] Manual smoke: per-repo specs with 3 repos — each card has its
      own Q&A panel, answers route per-repo correctly.
- [ ] Phase H (optional): clarify migrated to `runStageWithQA`,
      `clarify-question` alias removed, dashboard-only WS event is
      `stage-question`.

### Combined sanity

- [ ] With both Q&A enabled AND policy pauses enabled on `pet-company`,
      run an ambiguous feature end-to-end:
      - Stage shows Q&A → user answers → artifact lands → policy
        pause → review modal opens with Q&A history disclosure.
- [ ] With master OFF (policy disabled) but Q&A enabled, confirm Q&A
      still fires (orthogonal gates).
- [ ] With master ON but Q&A disabled, confirm one-shot artifacts +
      policy pauses still fire (orthogonal gates).
