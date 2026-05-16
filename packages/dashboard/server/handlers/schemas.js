/**
 * Zod schemas for every WS action (Recipe 6 / Prereq A of the dashboard
 * decomposition plan). One `Z.<Action>` per handler `case '<action>':`.
 *
 * Why this file exists: today, ~150 handler bodies in `dashboard-server.ts`
 * destructure raw `msg` via `(msg as { … })` casts. That's brittle:
 *   - field renames silently break callers,
 *   - missing fields manifest as runtime `undefined` reads deep in handler
 *     bodies (or worse, are passed through to stores),
 *   - error responses are bespoke per case.
 *
 * The schemas here are the input contract for each action. Handler bodies
 * (and, post-Recipe 7, registry entries) call `Z.<Action>.safeParse(msg)`
 * once and either reply with a `type:'error'` envelope on failure or
 * destructure the typed `parsed.data` on success.
 *
 * Sequencing follows DASHBOARD-DECOMPOSITION-PLAN.md §"Prereq A — Recipe 6":
 *   1. Run lifecycle (this PR — 13 schemas covering 16 case labels)
 *   2. Plans
 *   3. Reviews
 *   4. Tests
 *   5. Incidents + replay
 *   6. KB + project graph + bind
 *   7. Everything else
 *
 * Gotchas worth re-reading from the plan:
 *   - Use `.passthrough()` not `.strict()`. The legacy handlers ignored
 *     extra fields silently; tightening to `.strict()` would break clients
 *     that send junk along with valid fields.
 *   - Error messages from `safeParse(...).error.message` are asserted by
 *     existing tests (e.g. `5.4 add-plan-comment` asserts
 *     `/project.*planSlug.*sectionPath.*body/`). Don't switch to a custom
 *     error formatter without updating the regex.
 */
import { z } from 'zod';
// ────────────────────────────────────────────────────────────────────────────
// Shared sub-schemas
// ────────────────────────────────────────────────────────────────────────────
/**
 * `options` blob threaded into `run-pipeline`, `resume`, `run-fix`, etc.
 * Mirrors today's loose shape — every field is optional because the legacy
 * dispatch reads them via `?.` chains.
 */
const RunOptions = z
    .object({
    model: z.string().optional(),
    baseBranch: z.string().optional(),
    skipClarify: z.boolean().optional(),
    skipShip: z.boolean().optional(),
    resumeFromStage: z.number().int().nonnegative().optional(),
    featureSlug: z.string().optional(),
    failureContext: z.string().optional(),
    planSeed: z.unknown().optional(),
})
    .passthrough();
// ────────────────────────────────────────────────────────────────────────────
// Run lifecycle (Domain 1)
// ────────────────────────────────────────────────────────────────────────────
/** `get-state` — reissue `init`. No input fields. */
export const GetState = z.object({ action: z.literal('get-state') }).passthrough();
/** `get-projects` — alias of `get-state`. No input fields. */
export const GetProjects = z.object({ action: z.literal('get-projects') }).passthrough();
/** `get-features` — list FeatureStore entries for `project`. */
export const GetFeatures = z
    .object({
    action: z.literal('get-features'),
    project: z.string().min(1),
})
    .passthrough();
/** `get-runs` — return loadRunsSync(). No input fields. */
export const GetRuns = z.object({ action: z.literal('get-runs') }).passthrough();
/** `run-pipeline` — start a fresh build pipeline. */
export const RunPipeline = z
    .object({
    action: z.literal('run-pipeline'),
    project: z.string().min(1),
    feature: z.string().min(1),
    options: RunOptions.optional(),
})
    .passthrough();
/**
 * `resume` and `resume-pipeline` — restart a failed/stopped/cancelled run.
 * Identifying the run is via `runId` (preferred) OR `featureSlug` + `project`
 * (checkpoint-driven). At least one path must be present; the handler walks
 * checkpoint → RUNS_INDEX and errors back if neither resolves.
 */
export const ResumePipeline = z
    .object({
    action: z.union([z.literal('resume'), z.literal('resume-pipeline')]),
    runId: z.string().optional(),
    featureSlug: z.string().optional(),
    project: z.string().optional(),
    options: RunOptions.optional(),
})
    .passthrough();
/** `rollback-run` — switch repos off feature branch + delete the local branch. */
export const RollbackRun = z
    .object({
    action: z.literal('rollback-run'),
    runId: z.string().min(1),
})
    .passthrough();
/** `cancel-pipeline` — cancel the in-flight pipeline runner. No input. */
export const CancelPipeline = z
    .object({ action: z.literal('cancel-pipeline') })
    .passthrough();
/**
 * `send-input` — forward text into the active pipeline's clarify wait,
 * a named agent, or the legacy child process. The legacy handler tolerates
 * any combination (it falls through `pipeline → agent → child`), so we
 * keep every field optional.
 */
export const SendInput = z
    .object({
    action: z.literal('send-input'),
    text: z.string().optional(),
    agentId: z.string().optional(),
})
    .passthrough();
/**
 * `spawn-agent` — manually spawn a one-shot agent attached to (project, feature).
 * The handler injects KB context when `projectPrompt` is absent.
 */
export const SpawnAgent = z
    .object({
    action: z.literal('spawn-agent'),
    project: z.string().min(1),
    feature: z.string().min(1),
    name: z.string().optional(),
    persona: z.string().optional(),
    stage: z.string().optional(),
    projectPrompt: z.string().optional(),
    options: RunOptions.optional(),
})
    .passthrough();
/** `kill-agent` — SIGTERM/abort a specific agent. */
export const KillAgent = z
    .object({
    action: z.literal('kill-agent'),
    agentId: z.string().min(1),
})
    .passthrough();
/**
 * `stop-run` — flip a run to failed, broadcast, then walk the kill chain
 * (runner.cancel + every mapped agent). The handler MUST broadcast before
 * killing — see Gotcha "Stopping a build — broadcast first, kill chain after"
 * in dashboard CLAUDE.md.
 */
export const StopRun = z
    .object({
    action: z.literal('stop-run'),
    runId: z.string().min(1),
})
    .passthrough();
/** `get-active-runs` — broadcast a fresh active-runs frame. No input. */
export const GetActiveRuns = z
    .object({ action: z.literal('get-active-runs') })
    .passthrough();
/**
 * `get-run` — fetch a single run by id (active-first, falls back to RUNS_INDEX).
 * Returns `type:'run-data'` on hit, `type:'error'` on miss.
 */
export const GetRun = z
    .object({
    action: z.literal('get-run'),
    runId: z.string().min(1),
})
    .passthrough();
/**
 * `run-fix` / `run-review` / `run-spike` — quick-action runners. Same input
 * shape: project + feature description + optional model override.
 */
export const RunQuickAction = z
    .object({
    action: z.union([
        z.literal('run-fix'),
        z.literal('run-review'),
        z.literal('run-spike'),
    ]),
    project: z.string().min(1),
    feature: z.string().min(1),
    options: RunOptions.optional(),
})
    .passthrough();
/** `run-plan` — spawn the planning agent. Same project+feature shape. */
export const RunPlan = z
    .object({
    action: z.literal('run-plan'),
    project: z.string().min(1),
    feature: z.string().min(1),
    options: RunOptions.optional(),
})
    .passthrough();
// ────────────────────────────────────────────────────────────────────────────
// Plans (Domain 2)
// ────────────────────────────────────────────────────────────────────────────
/** One variant entry in `run-plan-variants`. */
const PlanVariant = z
    .object({
    label: z.string().min(1),
    prompt: z.string().optional(),
})
    .passthrough();
/** `run-plan-variants` — spawn N plan agents in parallel from labelled prompts. */
export const RunPlanVariants = z
    .object({
    action: z.literal('run-plan-variants'),
    project: z.string().min(1),
    feature: z.string().min(1),
    variants: z.array(PlanVariant).min(1),
    options: RunOptions.optional(),
})
    .passthrough();
/** `adopt-plan-variant` — promote a variant slug to a fresh canonical plan. */
export const AdoptPlanVariant = z
    .object({
    action: z.literal('adopt-plan-variant'),
    project: z.string().min(1),
    planSlug: z.string().min(1),
})
    .passthrough();
/** `list-plan-comments` — read the comment thread for a plan. */
export const ListPlanComments = z
    .object({
    action: z.literal('list-plan-comments'),
    project: z.string().min(1),
    planSlug: z.string().min(1),
})
    .passthrough();
/**
 * `add-plan-comment` — append a comment scoped to a section path.
 * Test `5.4 add-plan-comment` asserts the error message contains all four
 * field names (`/project.*planSlug.*sectionPath.*body/`). Zod's default
 * issue serialisation includes the path of every missing field — keep the
 * schema's field declaration order identical to satisfy that regex.
 */
export const AddPlanComment = z
    .object({
    action: z.literal('add-plan-comment'),
    project: z.string().min(1),
    planSlug: z.string().min(1),
    sectionPath: z.string().min(1),
    body: z.string().min(1),
    author: z.string().optional(),
})
    .passthrough();
/** `resolve-plan-comment` — mark a comment as resolved. */
export const ResolvePlanComment = z
    .object({
    action: z.literal('resolve-plan-comment'),
    project: z.string().min(1),
    planSlug: z.string().min(1),
    commentId: z.string().min(1),
})
    .passthrough();
/** `delete-plan-comment` — remove a comment. */
export const DeletePlanComment = z
    .object({
    action: z.literal('delete-plan-comment'),
    project: z.string().min(1),
    planSlug: z.string().min(1),
    commentId: z.string().min(1),
})
    .passthrough();
/** `list-plan-approvals` — read approval records + the current pointer. */
export const ListPlanApprovals = z
    .object({
    action: z.literal('list-plan-approvals'),
    project: z.string().min(1),
    planSlug: z.string().min(1),
})
    .passthrough();
/** `approve-plan` — add an approval record pinned to the current content hash. */
export const ApprovePlan = z
    .object({
    action: z.literal('approve-plan'),
    project: z.string().min(1),
    planSlug: z.string().min(1),
    user: z.string().optional(),
    note: z.string().optional(),
})
    .passthrough();
/** `get-plan-lifecycle` — snapshot the lifecycle walker for a plan. */
export const GetPlanLifecycle = z
    .object({
    action: z.literal('get-plan-lifecycle'),
    project: z.string().min(1),
    planSlug: z.string().min(1),
})
    .passthrough();
/** `share-plan` — mint a signed share token + URL with a TTL. */
export const SharePlan = z
    .object({
    action: z.literal('share-plan'),
    project: z.string().min(1),
    planSlug: z.string().min(1),
    ttlMs: z.number().positive().optional(),
    httpPort: z.number().int().nonnegative().optional(),
})
    .passthrough();
/** `get-plans` — list every plan, optionally scoped to one project. */
export const GetPlans = z
    .object({
    action: z.literal('get-plans'),
    project: z.string().optional(),
})
    .passthrough();
/** `get-plan` — fetch the current version + its validation + version index. */
export const GetPlan = z
    .object({
    action: z.literal('get-plan'),
    project: z.string().min(1),
    planSlug: z.string().min(1),
})
    .passthrough();
/**
 * `save-plan` — bump the plan version with a partial update.
 * `plan` is the partial body; left as `z.record(z.unknown())` because the
 * full `Plan` shape is owned by `plan-store.ts` and we don't want a circular
 * type dep from `handlers/` into `server/`.
 */
export const SavePlan = z
    .object({
    action: z.literal('save-plan'),
    project: z.string().min(1),
    planSlug: z.string().min(1),
    plan: z.record(z.string(), z.unknown()),
})
    .passthrough();
/** `validate-plan` — run the validator (optionally deep, with budget + gh lookups). */
export const ValidatePlan = z
    .object({
    action: z.literal('validate-plan'),
    project: z.string().min(1),
    planSlug: z.string().min(1),
    deep: z.boolean().optional(),
})
    .passthrough();
/** `estimate-plan` — deterministic what-if estimate with repo + tier overrides. */
export const EstimatePlan = z
    .object({
    action: z.literal('estimate-plan'),
    project: z.string().min(1),
    planSlug: z.string().min(1),
    excludeRepos: z.array(z.string()).optional(),
    modelTier: z.enum(['fast', 'balanced', 'thorough']).optional(),
})
    .passthrough();
/** `regen-plan-section` — re-run a single section with the planner agent. */
export const RegenPlanSection = z
    .object({
    action: z.literal('regen-plan-section'),
    project: z.string().min(1),
    planSlug: z.string().min(1),
    section: z.string().min(1),
    options: RunOptions.optional(),
})
    .passthrough();
/** `get-plan-lineage` — version index with hashes for the lineage popover. */
export const GetPlanLineage = z
    .object({
    action: z.literal('get-plan-lineage'),
    project: z.string().min(1),
    planSlug: z.string().min(1),
})
    .passthrough();
/** `auto-refine-plan` — user-triggered refine pass (the ONLY refine entry). */
export const AutoRefinePlan = z
    .object({
    action: z.literal('auto-refine-plan'),
    project: z.string().min(1),
    planSlug: z.string().min(1),
})
    .passthrough();
/** `execute-plan` — gate on validation+approval (force overrides), then start pipeline. */
export const ExecutePlan = z
    .object({
    action: z.literal('execute-plan'),
    project: z.string().min(1),
    planSlug: z.string().min(1),
    force: z.boolean().optional(),
    options: RunOptions.optional(),
})
    .passthrough();
// ────────────────────────────────────────────────────────────────────────────
// Reviews (Domain 3)
// ────────────────────────────────────────────────────────────────────────────
// Review handlers use SIX different error wire-types — preserved on a per-case
// basis. `safeParse` failures here still route to the right wire-type because
// the handler's `if (!parsed.success)` arm uses the case's own error envelope.
//
// Wire-type map:
//   run-review-pr           → 'error' (validation), 'review-error' (runtime)
//   run-review-incremental  → 'error' (404), 'review-error' (runtime)
//   get-review              → no error response (silent break)
//   list-reviews            → no error response (best-effort)
//   publish-review          → 'error' (404), 'review-error' (runtime)
//   resolve-review-finding  → 'error' (404 finding)
//   apply-review-fix        → 'review-error' (runtime)
//   list-review-dismissals  → 'review-dismissals-error'
//   reset-review-dismissal  → no input
//   apply-review-patch      → 'review-patch-error' (carries findingId)
//   get-reviewer-calibration→ 'reviewer-calibration-error'
//   synthesize-review-verdict→ 'review-verdict-error'
const Persona = z.enum(['architect', 'security', 'style', 'tester', 'domain']);
const Resolution = z.enum(['pending', 'addressed', 'dismissed', 'wont-fix']);
/** `run-review-pr` — kick off a PR review run with selected personas. */
export const RunReviewPr = z
    .object({
    action: z.literal('run-review-pr'),
    project: z.string().min(1),
    prUrl: z.string().min(1),
    options: z
        .object({
        model: z.string().optional(),
        personas: z.array(Persona).optional(),
    })
        .passthrough()
        .optional(),
})
    .passthrough();
/** `run-review-incremental` — re-run a review against the same PR after a push. */
export const RunReviewIncremental = z
    .object({
    action: z.literal('run-review-incremental'),
    project: z.string().min(1),
    reviewId: z.string().min(1),
    options: RunOptions.optional(),
})
    .passthrough();
/** `get-review` — fetch the current review snapshot. */
export const GetReview = z
    .object({
    action: z.literal('get-review'),
    project: z.string().min(1),
    reviewId: z.string().min(1),
})
    .passthrough();
/** `list-reviews` — list reviews (project-scoped, capped at `limit`). */
export const ListReviews = z
    .object({
    action: z.literal('list-reviews'),
    project: z.string().optional(),
    limit: z.number().int().positive().optional(),
})
    .passthrough();
/** `publish-review` — push review comments to the PR. */
export const PublishReview = z
    .object({
    action: z.literal('publish-review'),
    project: z.string().min(1),
    reviewId: z.string().min(1),
})
    .passthrough();
/** `resolve-review-finding` — set the resolution on a single finding. */
export const ResolveReviewFinding = z
    .object({
    action: z.literal('resolve-review-finding'),
    project: z.string().min(1),
    reviewId: z.string().min(1),
    findingId: z.string().min(1),
    resolution: Resolution,
})
    .passthrough();
/** `apply-review-fix` — apply the agent-proposed fix for a finding. */
export const ApplyReviewFix = z
    .object({
    action: z.literal('apply-review-fix'),
    project: z.string().min(1),
    reviewId: z.string().min(1),
    findingId: z.string().min(1),
})
    .passthrough();
/** `list-review-dismissals` — list dismissal-suppression keys for a project. */
export const ListReviewDismissals = z
    .object({
    action: z.literal('list-review-dismissals'),
    project: z.string().min(1),
})
    .passthrough();
/** `reset-review-dismissal` — no-input ack (MVP-coarse re-enable). */
export const ResetReviewDismissal = z
    .object({ action: z.literal('reset-review-dismissal') })
    .passthrough();
/**
 * `apply-review-patch` — apply a proposed patch to a repo clone.
 * The validation-error response includes `findingId` (may be undefined when
 * the field is missing). Preserved verbatim from the legacy handler.
 */
export const ApplyReviewPatch = z
    .object({
    action: z.literal('apply-review-patch'),
    project: z.string().min(1),
    findingId: z.string().min(1),
    proposedPatch: z.string().min(1),
    runTests: z.boolean().optional(),
})
    .passthrough();
/** `get-reviewer-calibration` — empirical confidence snapshot per persona. */
export const GetReviewerCalibration = z
    .object({
    action: z.literal('get-reviewer-calibration'),
    project: z.string().min(1),
})
    .passthrough();
/** `synthesize-review-verdict` — fold an array of findings into one verdict. */
export const SynthesizeReviewVerdict = z
    .object({
    action: z.literal('synthesize-review-verdict'),
    findings: z.array(z.unknown()),
})
    .passthrough();
// ────────────────────────────────────────────────────────────────────────────
// Tests (Domain 4) — 22 actions
// ────────────────────────────────────────────────────────────────────────────
// Test handlers use a constellation of error wire-types:
//   test-fingerprint-error  (fingerprint-test-conventions)
//   test-spec-error         (create-test-spec-from-plan)
//   test-run-error          (run-test-spec)
//   test-review-error       (review-test-spec)
//   test-mutation-error     (mutation-test-spec)
//   test-polish-error       (polish-test-spec)
//   test-error              (everything else)
//   error                   (resolve-test-finding for missing finding only)
//
// Each case preserves its own error-routing on safeParse failure.
/** `get-test-specs` — list specs for a project. */
export const GetTestSpecs = z
    .object({
    action: z.literal('get-test-specs'),
    project: z.string().min(1),
})
    .passthrough();
/** `get-test-spec` — fetch a single spec by slug. */
export const GetTestSpec = z
    .object({
    action: z.literal('get-test-spec'),
    project: z.string().min(1),
    slug: z.string().min(1),
})
    .passthrough();
/** `get-test-cases` — fetch cases for a spec at a specific version. */
export const GetTestCases = z
    .object({
    action: z.literal('get-test-cases'),
    project: z.string().min(1),
    slug: z.string().min(1),
    version: z.number().int().nonnegative(),
})
    .passthrough();
/** `get-test-runs` — list runs for a spec. */
export const GetTestRuns = z
    .object({
    action: z.literal('get-test-runs'),
    project: z.string().min(1),
    slug: z.string().min(1),
})
    .passthrough();
/** `fingerprint-test-conventions` — sniff a repo's test conventions. */
export const FingerprintTestConventions = z
    .object({
    action: z.literal('fingerprint-test-conventions'),
    project: z.string().min(1),
})
    .passthrough();
/** `create-test-spec-from-plan` — derive a spec + cases from a plan. */
export const CreateTestSpecFromPlan = z
    .object({
    action: z.literal('create-test-spec-from-plan'),
    project: z.string().min(1),
    planSlug: z.string().min(1),
    model: z.string().optional(),
})
    .passthrough();
/** `run-test-spec` — execute a spec's cases against a repo clone. */
export const RunTestSpec = z
    .object({
    action: z.literal('run-test-spec'),
    project: z.string().min(1),
    slug: z.string().min(1),
})
    .passthrough();
/** `review-test-spec` — multi-persona review pass over a test run. */
export const ReviewTestSpec = z
    .object({
    action: z.literal('review-test-spec'),
    project: z.string().min(1),
    slug: z.string().min(1),
    runId: z.string().min(1),
    personas: z.array(z.string()).optional(),
    model: z.string().optional(),
})
    .passthrough();
/** `mutation-test-spec` — run Stryker (or equivalent) against the repo. */
export const MutationTestSpec = z
    .object({
    action: z.literal('mutation-test-spec'),
    project: z.string().min(1),
    slug: z.string().min(1),
    runId: z.string().min(1),
})
    .passthrough();
/** `polish-test-spec` — N-agent polish pass for scaffolds. */
export const PolishTestSpec = z
    .object({
    action: z.literal('polish-test-spec'),
    project: z.string().min(1),
    slug: z.string().min(1),
    model: z.string().optional(),
    concurrency: z.number().int().positive().optional(),
})
    .passthrough();
/** `resolve-test-finding` — set the resolution on a test review/flakiness finding. */
export const ResolveTestFinding = z
    .object({
    action: z.literal('resolve-test-finding'),
    project: z.string().min(1),
    slug: z.string().min(1),
    runId: z.string().min(1),
    findingId: z.string().min(1),
    resolution: Resolution,
})
    .passthrough();
/** `regenerate-mutation-tests` — regen behaviors against a Stryker report. */
export const RegenerateMutationTests = z
    .object({
    action: z.literal('regenerate-mutation-tests'),
    project: z.string().min(1),
    slug: z.string().min(1),
    runId: z.string().min(1),
    threshold: z.number().min(0).max(1).optional(),
})
    .passthrough();
/** `generate-contract-tests` — derive contract tests from OpenAPI/proto/etc. */
export const GenerateContractTests = z
    .object({
    action: z.literal('generate-contract-tests'),
    project: z.string().min(1),
    slug: z.string().optional(),
})
    .passthrough();
/** `generate-integration-scenarios` — synthesize cross-step journeys from a plan. */
export const GenerateIntegrationScenarios = z
    .object({
    action: z.literal('generate-integration-scenarios'),
    project: z.string().min(1),
    planSlug: z.string().min(1),
    slug: z.string().optional(),
    extraJourneys: z.array(z.string()).optional(),
})
    .passthrough();
/** `analyze-flakiness` — per-case flakiness investigation. */
export const AnalyzeFlakiness = z
    .object({
    action: z.literal('analyze-flakiness'),
    project: z.string().min(1),
    slug: z.string().min(1),
    runId: z.string().min(1),
    model: z.string().optional(),
})
    .passthrough();
/** `publish-test-checks` — emit GitHub Checks for the run. */
export const PublishTestChecks = z
    .object({
    action: z.literal('publish-test-checks'),
    project: z.string().min(1),
    slug: z.string().min(1),
    runId: z.string().min(1),
    headSha: z.string().min(1),
    repo: z.string().min(1),
})
    .passthrough();
/** `share-test-spec` — mint a signed share token + URL. */
export const ShareTestSpec = z
    .object({
    action: z.literal('share-test-spec'),
    project: z.string().min(1),
    slug: z.string().min(1),
    ttlMs: z.number().positive().optional(),
    httpPort: z.number().int().nonnegative().optional(),
})
    .passthrough();
/** `get-coverage-sla` — read the project's coverage SLA. */
export const GetCoverageSla = z
    .object({
    action: z.literal('get-coverage-sla'),
    project: z.string().min(1),
})
    .passthrough();
/**
 * `set-coverage-sla` — write the project's SLA. `sla` shape is owned by
 * `coverage-sla.ts`; left as unknown record to avoid a circular type dep.
 */
export const SetCoverageSla = z
    .object({
    action: z.literal('set-coverage-sla'),
    project: z.string().min(1),
    sla: z.record(z.string(), z.unknown()),
})
    .passthrough();
/** `check-coverage-sla` — compare a run against the SLA. */
export const CheckCoverageSla = z
    .object({
    action: z.literal('check-coverage-sla'),
    project: z.string().min(1),
    slug: z.string().min(1),
    runId: z.string().min(1),
})
    .passthrough();
/** `plan-parallelization` — CI matrix planner. */
export const PlanParallelization = z
    .object({
    action: z.literal('plan-parallelization'),
    project: z.string().min(1),
    slug: z.string().min(1),
    runner: z.string().optional(),
})
    .passthrough();
/** `detect-stale-tests` — surface candidate stale tests. */
export const DetectStaleTests = z
    .object({
    action: z.literal('detect-stale-tests'),
    project: z.string().min(1),
    slug: z.string().min(1),
})
    .passthrough();
// ────────────────────────────────────────────────────────────────────────────
// Incidents + replay + bind (Domain 5) — 11 actions
// ────────────────────────────────────────────────────────────────────────────
// Wire-type map (this domain has 7 distinct error wire-types):
//   list-incidents       → 'incident-error' (catch only; no validation reply)
//   list-replay-queue    → no error (best-effort)
//   get-incident         → no error (silent break)
//   get-incident-stats   → 'incident-error'
//   list-replays         → no error
//   list-bound-tests     → no error
//   ingest-incident      → 'incident-error'
//   replay-incident      → 'replay-error' (with incidentId in payload)
//   override-bind        → 'incident-error'
//   list-bound-audit     → 'bound-audit-error'
//   override-bound-test  → 'bound-override-error' (also for short-reason)
const IncidentSource = z.enum(['sentry', 'incident.io', 'datadog', 'manual']);
/** `list-incidents` — list every incident for a project. */
export const ListIncidents = z
    .object({
    action: z.literal('list-incidents'),
    project: z.string().min(1),
})
    .passthrough();
/** `list-replay-queue` — optionally project-scoped replay queue snapshot. */
export const ListReplayQueue = z
    .object({
    action: z.literal('list-replay-queue'),
    project: z.string().optional(),
})
    .passthrough();
/** `get-incident` — fetch a single incident by id. */
export const GetIncident = z
    .object({
    action: z.literal('get-incident'),
    project: z.string().min(1),
    incidentId: z.string().min(1),
})
    .passthrough();
/** `get-incident-stats` — aggregate stats across incidents + replays + bound tests. */
export const GetIncidentStats = z
    .object({
    action: z.literal('get-incident-stats'),
    project: z.string().min(1),
})
    .passthrough();
/** `list-replays` — replays for a project (optionally filtered by incident). */
export const ListReplays = z
    .object({
    action: z.literal('list-replays'),
    project: z.string().min(1),
    incidentId: z.string().optional(),
})
    .passthrough();
/** `list-bound-tests` — bound-tests registry entries. */
export const ListBoundTests = z
    .object({
    action: z.literal('list-bound-tests'),
    project: z.string().min(1),
})
    .passthrough();
/**
 * `ingest-incident` — parse an external incident into Anvil's incident store.
 * `payload` is source-specific (Sentry event JSON, incident.io event, etc.)
 * — left as `z.unknown()` to defer shape validation to the parser modules.
 */
export const IngestIncident = z
    .object({
    action: z.literal('ingest-incident'),
    project: z.string().min(1),
    source: IncidentSource,
    payload: z.unknown(),
})
    .passthrough()
    .refine((data) => data.payload != null, {
    message: 'payload must not be null/undefined',
    path: ['payload'],
});
/** `replay-incident` — drive the replay pipeline for an incident. */
export const ReplayIncident = z
    .object({
    action: z.literal('replay-incident'),
    project: z.string().min(1),
    incidentId: z.string().min(1),
    specSlug: z.string().optional(),
    model: z.string().optional(),
})
    .passthrough();
/** `override-bind` — remove a bound-tests entry (via replayId lookup). */
export const OverrideBind = z
    .object({
    action: z.literal('override-bind'),
    project: z.string().min(1),
    replayId: z.string().min(1),
    reason: z.string().min(1),
})
    .passthrough();
/** `list-bound-audit` — recent bound-tests audit log entries. */
export const ListBoundAudit = z
    .object({
    action: z.literal('list-bound-audit'),
    project: z.string().min(1),
})
    .passthrough();
/**
 * `override-bound-test` — remove a bound test by filePath, with audit.
 * The legacy handler enforced `reason.length >= 20` (must justify the
 * override). Preserved verbatim — `bound-override-error` carries this
 * back to the UI.
 */
export const OverrideBoundTest = z
    .object({
    action: z.literal('override-bound-test'),
    project: z.string().min(1),
    filePath: z.string().min(1),
    reason: z.string().min(20, 'reason must be at least 20 characters'),
})
    .passthrough();
// ────────────────────────────────────────────────────────────────────────────
// KB + project graph + overview + memory (Domain 6) — 13 actions
// ────────────────────────────────────────────────────────────────────────────
// The legacy handlers here are lenient — most accept `msg.project ?? ''` and
// only emit an error if the resulting empty string can't be served. The Zod
// versions tighten by requiring `project: z.string().min(1)` where the
// handler would have errored anyway, and stay lenient where the legacy
// behavior was lenient (e.g. `get-project-graph-status` with no project).
const MemoryTargetSchema = z.enum(['memory', 'user']);
/** `get-overview` — project overview (memory + KB summary + recent runs). */
export const GetOverview = z
    .object({
    action: z.literal('get-overview'),
    project: z.string().optional(),
})
    .passthrough();
/** `memory-add` — append a memory entry. */
export const MemoryAdd = z
    .object({
    action: z.literal('memory-add'),
    project: z.string().optional(),
    target: MemoryTargetSchema.optional(),
    content: z.string().optional(),
})
    .passthrough();
/** `memory-replace` — replace a chunk of memory by exact-text match. */
export const MemoryReplace = z
    .object({
    action: z.literal('memory-replace'),
    project: z.string().optional(),
    target: MemoryTargetSchema.optional(),
    oldText: z.string().optional(),
    content: z.string().optional(),
})
    .passthrough();
/** `memory-remove` — delete a chunk of memory by exact-text match. */
export const MemoryRemove = z
    .object({
    action: z.literal('memory-remove'),
    project: z.string().optional(),
    target: MemoryTargetSchema.optional(),
    oldText: z.string().optional(),
})
    .passthrough();
/** `refresh-prs` — re-poll tracked PRs from GitHub. No input. */
export const RefreshPRs = z
    .object({ action: z.literal('refresh-prs') })
    .passthrough();
/**
 * `get-kb-data` — KB graph report + status for a project.
 * `repo`: empty/missing = aggregate report across all repos; `'__system__'`
 * = system-level synthesis; otherwise a repo name.
 */
export const GetKbData = z
    .object({
    action: z.literal('get-kb-data'),
    project: z.string().min(1),
    repo: z.string().optional(),
})
    .passthrough();
/** `query-kb` — hybrid retrieval query for context. */
export const QueryKb = z
    .object({
    action: z.literal('query-kb'),
    project: z.string().min(1),
    query: z.string().min(1),
    maxChars: z.number().int().positive().optional(),
})
    .passthrough();
/** `get-kb-index` — keyword-prompt index for a project. */
export const GetKbIndex = z
    .object({
    action: z.literal('get-kb-index'),
    project: z.string().min(1),
})
    .passthrough();
/** `get-kb-status` — async status snapshot (last-refresh, refreshing-now, etc). */
export const GetKbStatus = z
    .object({
    action: z.literal('get-kb-status'),
    project: z.string().min(1),
})
    .passthrough();
/** `refresh-knowledge-base` — kick off a project-wide KB rebuild. */
export const RefreshKnowledgeBase = z
    .object({
    action: z.literal('refresh-knowledge-base'),
    project: z.string().min(1),
})
    .passthrough();
/** `build-project-graph` — LLM-driven cross-repo graph build. */
export const BuildProjectGraph = z
    .object({
    action: z.literal('build-project-graph'),
    project: z.string().min(1),
    provider: z.string().optional(),
    model: z.string().optional(),
})
    .passthrough();
/**
 * `get-project-graph-status` — read-only status snapshot. Legacy lenient:
 * no project still returns a synthesized empty payload, so the schema
 * makes `project` optional here.
 */
export const GetProjectGraphStatus = z
    .object({
    action: z.literal('get-project-graph-status'),
    project: z.string().optional(),
})
    .passthrough();
/** `get-graph-nodes` — graph.json data for the force-graph viz. */
export const GetGraphNodes = z
    .object({
    action: z.literal('get-graph-nodes'),
    project: z.string().min(1),
    options: z
        .object({
        repo: z.string().optional(),
        level: z.enum(['project', 'repo']).optional(),
    })
        .passthrough()
        .optional(),
})
    .passthrough();
// ────────────────────────────────────────────────────────────────────────────
// Domain 7 — long tail (cost, policy, learnings, contracts, CI triage, etc.)
// ────────────────────────────────────────────────────────────────────────────
// This domain catches every remaining `(msg as { … }).<field>` cast in the
// long tail. The handlers here use ~10 distinct error wire-types — schemas
// are paired 1:1 with case names so the existing error routing is preserved
// case-by-case.
//
// Schemas not in this block (some 18 actions like `get-providers`,
// `set-auth-key`, etc.) already destructure via `ClientMessage`'s typed
// fields, so they ship a schema in a follow-up sub-PR alongside Recipe 7
// when the registry needs them.
// ── Pipeline pauses ──────────────────────────────────────────────────────
/**
 * `resume-pipeline` (pause variant) and `cancel-pipeline-pause` both forward
 * the whole `msg` into `handle*` helpers from `pipeline-pauses.ts`. We only
 * read `runId` at the handler level for the side-channel emit.
 */
export const ResumePipelinePause = z
    .object({
    action: z.literal('resume-pipeline'),
    runId: z.string().optional(),
})
    .passthrough();
export const CancelPipelinePause = z
    .object({
    action: z.literal('cancel-pipeline-pause'),
    runId: z.string().optional(),
})
    .passthrough();
// ── Cost ─────────────────────────────────────────────────────────────────
/** `get-cost-summary` — cost ledger summary for a run. */
export const GetCostSummary = z
    .object({
    action: z.literal('get-cost-summary'),
    runId: z.string().min(1),
})
    .passthrough();
/** `get-cost-breach` — last breach state for a run. */
export const GetCostBreach = z
    .object({
    action: z.literal('get-cost-breach'),
    runId: z.string().min(1),
})
    .passthrough();
/** `respond-cost-breach` — operator decision for a breach. */
export const RespondCostBreach = z
    .object({
    action: z.literal('respond-cost-breach'),
    runId: z.string().min(1),
    decision: z.enum(['raise', 'reject', 'extend']),
    deltaUsd: z.number().optional(),
    extendSeconds: z.number().optional(),
})
    .passthrough();
/** `subscribe-cost` — emit initial snapshot for room-based cost broadcasts. */
export const SubscribeCost = z
    .object({
    action: z.literal('subscribe-cost'),
    project: z.string().min(1),
    runId: z.string().optional(),
})
    .passthrough();
/** `get-pipeline-policy` — read merged + overlay policy for project. */
export const GetPipelinePolicy = z
    .object({
    action: z.literal('get-pipeline-policy'),
    project: z.string().min(1),
})
    .passthrough();
/**
 * `update-pipeline-policy` — apply a patch to the cost policy. `patch` is
 * partial and matches the legacy duck-typed shape — kept as a permissive
 * record so the handler keeps owning per-field validation (e.g. the
 * graceWindowSeconds 10–600 range).
 */
export const UpdatePipelinePolicy = z
    .object({
    action: z.literal('update-pipeline-policy'),
    project: z.string().min(1),
    patch: z.record(z.string(), z.unknown()),
})
    .passthrough();
/** `list-cost-breaches` — list all breach records (optionally scoped). */
export const ListCostBreaches = z
    .object({
    action: z.literal('list-cost-breaches'),
    project: z.string().optional(),
})
    .passthrough();
// ── Learning loop ────────────────────────────────────────────────────────
/** `get-plan-approval-stats` — approval/rejection counts for the project. */
export const GetPlanApprovalStats = z
    .object({
    action: z.literal('get-plan-approval-stats'),
    project: z.string().min(1),
})
    .passthrough();
/** `list-plan-approval-records` — per-record approval log with filters. */
export const ListPlanApprovalRecords = z
    .object({
    action: z.literal('list-plan-approval-records'),
    project: z.string().min(1),
    limit: z.number().int().positive().optional(),
    since: z.string().optional(),
    outcome: z.enum(['approved', 'modified', 'rejected', 'timed-out', 'replanned']).optional(),
})
    .passthrough();
// ── Checkpoints / regression / contracts ─────────────────────────────────
/** `get-checkpoint-stats` — stats per (project, runFamily). */
export const GetCheckpointStats = z
    .object({
    action: z.literal('get-checkpoint-stats'),
    project: z.string().min(1),
    runFamily: z.string().min(1),
})
    .passthrough();
/** `get-regression-metrics` — incident/replay/bound rollup. */
export const GetRegressionMetrics = z
    .object({
    action: z.literal('get-regression-metrics'),
    project: z.string().min(1),
})
    .passthrough();
/** `list-contracts` — discovered contracts (openapi/proto/etc) for project. */
export const ListContracts = z
    .object({
    action: z.literal('list-contracts'),
    project: z.string().min(1),
})
    .passthrough();
/** `rescan-contracts` — re-discover + build contract graph. */
export const RescanContracts = z
    .object({
    action: z.literal('rescan-contracts'),
    project: z.string().min(1),
})
    .passthrough();
/** `get-flakiness-clusters` — clusters + fix suggestions for flaky tests. */
export const GetFlakinessClusters = z
    .object({
    action: z.literal('get-flakiness-clusters'),
    project: z.string().min(1),
    specSlug: z.string().optional(),
})
    .passthrough();
/** `rank-tests-for-pr` — relevance ranking from changed symbols. */
export const RankTestsForPr = z
    .object({
    action: z.literal('rank-tests-for-pr'),
    project: z.string().min(1),
    changedSymbols: z.array(z.unknown()),
})
    .passthrough();
// ── CI triage ────────────────────────────────────────────────────────────
/** `analyze-ci-log` — cluster errors from a raw CI log dump. */
export const AnalyzeCiLog = z
    .object({
    action: z.literal('analyze-ci-log'),
    project: z.string().optional(),
    logText: z.string().min(1),
    logSource: z.string().optional(),
})
    .passthrough();
/** `fetch-ci-log` — fetch GHA log via `gh run view`. */
export const FetchCiLog = z
    .object({
    action: z.literal('fetch-ci-log'),
    project: z.string().optional(),
    logUrl: z.string().min(1),
})
    .passthrough();
/** `save-ci-triage` — persist an analysis report. Falls back to cached on ws. */
export const SaveCiTriage = z
    .object({
    action: z.literal('save-ci-triage'),
    project: z.string().min(1),
    ciRunId: z.string().optional(),
    report: z.unknown().optional(),
})
    .passthrough();
/** `list-ci-triage` — history of saved CI triage reports. */
export const ListCiTriage = z
    .object({
    action: z.literal('list-ci-triage'),
    project: z.string().min(1),
    limit: z.number().int().positive().optional(),
})
    .passthrough();
// ────────────────────────────────────────────────────────────────────────────
// Domain 7 — remaining no-cast actions (settings / providers / pauses / memory)
// ────────────────────────────────────────────────────────────────────────────
// These schemas exist for Recipe 7 — the registry adapter routes msg→handler
// via Zod, so even cast-free reads need a Z.<Action> to land. Handler bodies
// here already destructure cleanly via `ClientMessage`'s typed fields; no
// body refactor is required, just the schema.
/** `get-interrupted-pipelines` — no input. */
export const GetInterruptedPipelines = z
    .object({ action: z.literal('get-interrupted-pipelines') })
    .passthrough();
/** `get-branches` — list remote branches for a project's primary repo. */
export const GetBranches = z
    .object({
    action: z.literal('get-branches'),
    project: z.string().optional(),
})
    .passthrough();
/** `get-providers` — discovery snapshot for the Settings UI. */
export const GetProviders = z
    .object({ action: z.literal('get-providers') })
    .passthrough();
/** `get-available-models` — modelregistry list with per-provider availability. */
export const GetAvailableModels = z
    .object({ action: z.literal('get-available-models') })
    .passthrough();
/** `get-routing` — stage→model chain resolution for every flow. */
export const GetRouting = z
    .object({ action: z.literal('get-routing') })
    .passthrough();
/** `get-budget-status` — today's spend vs caps. */
export const GetBudgetStatus = z
    .object({
    action: z.literal('get-budget-status'),
    project: z.string().optional(),
})
    .passthrough();
/** `set-budget` — write cap config to factory.yaml. */
export const SetBudget = z
    .object({
    action: z.literal('set-budget'),
    project: z.string().min(1),
    maxPerRun: z.number().optional(),
    maxPerDay: z.number().optional(),
    alertAt: z.number().optional(),
})
    .passthrough();
/** `get-conventions` — read convention rules for a project. */
export const GetConventions = z
    .object({
    action: z.literal('get-conventions'),
    project: z.string().optional(),
})
    .passthrough();
/** `get-memory-config` — read reflection mode + sleeptime interval. */
export const GetMemoryConfig = z
    .object({ action: z.literal('get-memory-config') })
    .passthrough();
/** `list-memories` — paginated memories list with search + stats + proposals. */
export const ListMemories = z
    .object({
    action: z.literal('list-memories'),
    project: z.string().optional(),
    search: z.string().optional(),
    kind: z.string().optional(),
    limit: z.number().int().positive().optional(),
})
    .passthrough();
/** `ratify-proposal` — accept a memory proposal by id. */
export const RatifyProposal = z
    .object({
    action: z.literal('ratify-proposal'),
    id: z.string().min(1),
})
    .passthrough();
/** `reject-proposal` — reject a memory proposal with optional reason. */
export const RejectProposal = z
    .object({
    action: z.literal('reject-proposal'),
    id: z.string().min(1),
    reason: z.string().optional(),
})
    .passthrough();
/** `generate-conventions` — kick off convention extraction. */
export const GenerateConventions = z
    .object({
    action: z.literal('generate-conventions'),
    project: z.string().min(1),
})
    .passthrough();
/** `get-auth-status` — env-var presence map for known providers. */
export const GetAuthStatus = z
    .object({ action: z.literal('get-auth-status') })
    .passthrough();
/** `set-auth-key` — set provider env var + persist to ~/.anvil/.env. */
export const SetAuthKey = z
    .object({
    action: z.literal('set-auth-key'),
    provider: z.string().min(1),
    key: z.string().min(1),
})
    .passthrough();
/** `test-auth` — lightweight API ping per provider. */
export const TestAuth = z
    .object({
    action: z.literal('test-auth'),
    provider: z.string().min(1),
})
    .passthrough();
/** `approve-gate` — clear pending approval. */
export const ApproveGate = z
    .object({
    action: z.literal('approve-gate'),
    stage: z.number().int().optional(),
})
    .passthrough();
/** `list-pipeline-pauses` — passes whole msg to handleListPauses helper. */
export const ListPipelinePauses = z
    .object({ action: z.literal('list-pipeline-pauses') })
    .passthrough();
/** `get-pipeline-pause` — passes whole msg to handleGetPause helper. */
export const GetPipelinePause = z
    .object({ action: z.literal('get-pipeline-pause') })
    .passthrough();
/** `unsubscribe-cost` — no-op under room-based model. */
export const UnsubscribeCost = z
    .object({ action: z.literal('unsubscribe-cost') })
    .passthrough();
/** `list-pending-breaches` — pending cost-breach decisions. */
export const ListPendingBreaches = z
    .object({ action: z.literal('list-pending-breaches') })
    .passthrough();
//# sourceMappingURL=schemas.js.map