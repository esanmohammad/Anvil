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
/** `get-state` — reissue `init`. No input fields. */
export declare const GetState: z.ZodObject<{
    action: z.ZodLiteral<"get-state">;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-state">;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-state">;
}, z.ZodTypeAny, "passthrough">>;
/** `get-projects` — alias of `get-state`. No input fields. */
export declare const GetProjects: z.ZodObject<{
    action: z.ZodLiteral<"get-projects">;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-projects">;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-projects">;
}, z.ZodTypeAny, "passthrough">>;
/** `get-features` — list FeatureStore entries for `project`. */
export declare const GetFeatures: z.ZodObject<{
    action: z.ZodLiteral<"get-features">;
    project: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-features">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-features">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `get-runs` — return loadRunsSync(). No input fields. */
export declare const GetRuns: z.ZodObject<{
    action: z.ZodLiteral<"get-runs">;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-runs">;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-runs">;
}, z.ZodTypeAny, "passthrough">>;
/** `run-pipeline` — start a fresh build pipeline. */
export declare const RunPipeline: z.ZodObject<{
    action: z.ZodLiteral<"run-pipeline">;
    project: z.ZodString;
    feature: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"run-pipeline">;
    project: z.ZodString;
    feature: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"run-pipeline">;
    project: z.ZodString;
    feature: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>>;
}, z.ZodTypeAny, "passthrough">>;
/**
 * `resume` and `resume-pipeline` — restart a failed/stopped/cancelled run.
 * Identifying the run is via `runId` (preferred) OR `featureSlug` + `project`
 * (checkpoint-driven). At least one path must be present; the handler walks
 * checkpoint → RUNS_INDEX and errors back if neither resolves.
 */
export declare const ResumePipeline: z.ZodObject<{
    action: z.ZodUnion<[z.ZodLiteral<"resume">, z.ZodLiteral<"resume-pipeline">]>;
    runId: z.ZodOptional<z.ZodString>;
    featureSlug: z.ZodOptional<z.ZodString>;
    project: z.ZodOptional<z.ZodString>;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodUnion<[z.ZodLiteral<"resume">, z.ZodLiteral<"resume-pipeline">]>;
    runId: z.ZodOptional<z.ZodString>;
    featureSlug: z.ZodOptional<z.ZodString>;
    project: z.ZodOptional<z.ZodString>;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodUnion<[z.ZodLiteral<"resume">, z.ZodLiteral<"resume-pipeline">]>;
    runId: z.ZodOptional<z.ZodString>;
    featureSlug: z.ZodOptional<z.ZodString>;
    project: z.ZodOptional<z.ZodString>;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>>;
}, z.ZodTypeAny, "passthrough">>;
/** `rollback-run` — switch repos off feature branch + delete the local branch. */
export declare const RollbackRun: z.ZodObject<{
    action: z.ZodLiteral<"rollback-run">;
    runId: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"rollback-run">;
    runId: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"rollback-run">;
    runId: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `cancel-pipeline` — cancel the in-flight pipeline runner. No input. */
export declare const CancelPipeline: z.ZodObject<{
    action: z.ZodLiteral<"cancel-pipeline">;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"cancel-pipeline">;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"cancel-pipeline">;
}, z.ZodTypeAny, "passthrough">>;
/**
 * `send-input` — forward text into the active pipeline's clarify wait,
 * a named agent, or the legacy child process. The legacy handler tolerates
 * any combination (it falls through `pipeline → agent → child`), so we
 * keep every field optional.
 */
export declare const SendInput: z.ZodObject<{
    action: z.ZodLiteral<"send-input">;
    text: z.ZodOptional<z.ZodString>;
    agentId: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"send-input">;
    text: z.ZodOptional<z.ZodString>;
    agentId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"send-input">;
    text: z.ZodOptional<z.ZodString>;
    agentId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/**
 * `spawn-agent` — manually spawn a one-shot agent attached to (project, feature).
 * The handler injects KB context when `projectPrompt` is absent.
 */
export declare const SpawnAgent: z.ZodObject<{
    action: z.ZodLiteral<"spawn-agent">;
    project: z.ZodString;
    feature: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    persona: z.ZodOptional<z.ZodString>;
    stage: z.ZodOptional<z.ZodString>;
    projectPrompt: z.ZodOptional<z.ZodString>;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"spawn-agent">;
    project: z.ZodString;
    feature: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    persona: z.ZodOptional<z.ZodString>;
    stage: z.ZodOptional<z.ZodString>;
    projectPrompt: z.ZodOptional<z.ZodString>;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"spawn-agent">;
    project: z.ZodString;
    feature: z.ZodString;
    name: z.ZodOptional<z.ZodString>;
    persona: z.ZodOptional<z.ZodString>;
    stage: z.ZodOptional<z.ZodString>;
    projectPrompt: z.ZodOptional<z.ZodString>;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>>;
}, z.ZodTypeAny, "passthrough">>;
/** `kill-agent` — SIGTERM/abort a specific agent. */
export declare const KillAgent: z.ZodObject<{
    action: z.ZodLiteral<"kill-agent">;
    agentId: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"kill-agent">;
    agentId: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"kill-agent">;
    agentId: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/**
 * `stop-run` — flip a run to failed, broadcast, then walk the kill chain
 * (runner.cancel + every mapped agent). The handler MUST broadcast before
 * killing — see Gotcha "Stopping a build — broadcast first, kill chain after"
 * in dashboard CLAUDE.md.
 */
export declare const StopRun: z.ZodObject<{
    action: z.ZodLiteral<"stop-run">;
    runId: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"stop-run">;
    runId: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"stop-run">;
    runId: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `get-active-runs` — broadcast a fresh active-runs frame. No input. */
export declare const GetActiveRuns: z.ZodObject<{
    action: z.ZodLiteral<"get-active-runs">;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-active-runs">;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-active-runs">;
}, z.ZodTypeAny, "passthrough">>;
/**
 * `get-run` — fetch a single run by id (active-first, falls back to RUNS_INDEX).
 * Returns `type:'run-data'` on hit, `type:'error'` on miss.
 */
export declare const GetRun: z.ZodObject<{
    action: z.ZodLiteral<"get-run">;
    runId: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-run">;
    runId: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-run">;
    runId: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/**
 * `run-fix` / `run-review` / `run-spike` — quick-action runners. Same input
 * shape: project + feature description + optional model override.
 */
export declare const RunQuickAction: z.ZodObject<{
    action: z.ZodUnion<[z.ZodLiteral<"run-fix">, z.ZodLiteral<"run-review">, z.ZodLiteral<"run-spike">]>;
    project: z.ZodString;
    feature: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodUnion<[z.ZodLiteral<"run-fix">, z.ZodLiteral<"run-review">, z.ZodLiteral<"run-spike">]>;
    project: z.ZodString;
    feature: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodUnion<[z.ZodLiteral<"run-fix">, z.ZodLiteral<"run-review">, z.ZodLiteral<"run-spike">]>;
    project: z.ZodString;
    feature: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>>;
}, z.ZodTypeAny, "passthrough">>;
/** `run-plan` — spawn the planning agent. Same project+feature shape. */
export declare const RunPlan: z.ZodObject<{
    action: z.ZodLiteral<"run-plan">;
    project: z.ZodString;
    feature: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"run-plan">;
    project: z.ZodString;
    feature: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"run-plan">;
    project: z.ZodString;
    feature: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>>;
}, z.ZodTypeAny, "passthrough">>;
export type GetFeaturesInput = z.infer<typeof GetFeatures>;
export type RunPipelineInput = z.infer<typeof RunPipeline>;
export type ResumePipelineInput = z.infer<typeof ResumePipeline>;
export type RollbackRunInput = z.infer<typeof RollbackRun>;
export type SendInputInput = z.infer<typeof SendInput>;
export type SpawnAgentInput = z.infer<typeof SpawnAgent>;
export type KillAgentInput = z.infer<typeof KillAgent>;
export type StopRunInput = z.infer<typeof StopRun>;
export type GetRunInput = z.infer<typeof GetRun>;
export type RunQuickActionInput = z.infer<typeof RunQuickAction>;
export type RunPlanInput = z.infer<typeof RunPlan>;
/** `run-plan-variants` — spawn N plan agents in parallel from labelled prompts. */
export declare const RunPlanVariants: z.ZodObject<{
    action: z.ZodLiteral<"run-plan-variants">;
    project: z.ZodString;
    feature: z.ZodString;
    variants: z.ZodArray<z.ZodObject<{
        label: z.ZodString;
        prompt: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        label: z.ZodString;
        prompt: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        label: z.ZodString;
        prompt: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>, "many">;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"run-plan-variants">;
    project: z.ZodString;
    feature: z.ZodString;
    variants: z.ZodArray<z.ZodObject<{
        label: z.ZodString;
        prompt: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        label: z.ZodString;
        prompt: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        label: z.ZodString;
        prompt: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>, "many">;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"run-plan-variants">;
    project: z.ZodString;
    feature: z.ZodString;
    variants: z.ZodArray<z.ZodObject<{
        label: z.ZodString;
        prompt: z.ZodOptional<z.ZodString>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        label: z.ZodString;
        prompt: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        label: z.ZodString;
        prompt: z.ZodOptional<z.ZodString>;
    }, z.ZodTypeAny, "passthrough">>, "many">;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>>;
}, z.ZodTypeAny, "passthrough">>;
/** `adopt-plan-variant` — promote a variant slug to a fresh canonical plan. */
export declare const AdoptPlanVariant: z.ZodObject<{
    action: z.ZodLiteral<"adopt-plan-variant">;
    project: z.ZodString;
    planSlug: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"adopt-plan-variant">;
    project: z.ZodString;
    planSlug: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"adopt-plan-variant">;
    project: z.ZodString;
    planSlug: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `list-plan-comments` — read the comment thread for a plan. */
export declare const ListPlanComments: z.ZodObject<{
    action: z.ZodLiteral<"list-plan-comments">;
    project: z.ZodString;
    planSlug: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"list-plan-comments">;
    project: z.ZodString;
    planSlug: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"list-plan-comments">;
    project: z.ZodString;
    planSlug: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/**
 * `add-plan-comment` — append a comment scoped to a section path.
 * Test `5.4 add-plan-comment` asserts the error message contains all four
 * field names (`/project.*planSlug.*sectionPath.*body/`). Zod's default
 * issue serialisation includes the path of every missing field — keep the
 * schema's field declaration order identical to satisfy that regex.
 */
export declare const AddPlanComment: z.ZodObject<{
    action: z.ZodLiteral<"add-plan-comment">;
    project: z.ZodString;
    planSlug: z.ZodString;
    sectionPath: z.ZodString;
    body: z.ZodString;
    author: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"add-plan-comment">;
    project: z.ZodString;
    planSlug: z.ZodString;
    sectionPath: z.ZodString;
    body: z.ZodString;
    author: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"add-plan-comment">;
    project: z.ZodString;
    planSlug: z.ZodString;
    sectionPath: z.ZodString;
    body: z.ZodString;
    author: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** `resolve-plan-comment` — mark a comment as resolved. */
export declare const ResolvePlanComment: z.ZodObject<{
    action: z.ZodLiteral<"resolve-plan-comment">;
    project: z.ZodString;
    planSlug: z.ZodString;
    commentId: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"resolve-plan-comment">;
    project: z.ZodString;
    planSlug: z.ZodString;
    commentId: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"resolve-plan-comment">;
    project: z.ZodString;
    planSlug: z.ZodString;
    commentId: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `delete-plan-comment` — remove a comment. */
export declare const DeletePlanComment: z.ZodObject<{
    action: z.ZodLiteral<"delete-plan-comment">;
    project: z.ZodString;
    planSlug: z.ZodString;
    commentId: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"delete-plan-comment">;
    project: z.ZodString;
    planSlug: z.ZodString;
    commentId: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"delete-plan-comment">;
    project: z.ZodString;
    planSlug: z.ZodString;
    commentId: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `list-plan-approvals` — read approval records + the current pointer. */
export declare const ListPlanApprovals: z.ZodObject<{
    action: z.ZodLiteral<"list-plan-approvals">;
    project: z.ZodString;
    planSlug: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"list-plan-approvals">;
    project: z.ZodString;
    planSlug: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"list-plan-approvals">;
    project: z.ZodString;
    planSlug: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `approve-plan` — add an approval record pinned to the current content hash. */
export declare const ApprovePlan: z.ZodObject<{
    action: z.ZodLiteral<"approve-plan">;
    project: z.ZodString;
    planSlug: z.ZodString;
    user: z.ZodOptional<z.ZodString>;
    note: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"approve-plan">;
    project: z.ZodString;
    planSlug: z.ZodString;
    user: z.ZodOptional<z.ZodString>;
    note: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"approve-plan">;
    project: z.ZodString;
    planSlug: z.ZodString;
    user: z.ZodOptional<z.ZodString>;
    note: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** `get-plan-lifecycle` — snapshot the lifecycle walker for a plan. */
export declare const GetPlanLifecycle: z.ZodObject<{
    action: z.ZodLiteral<"get-plan-lifecycle">;
    project: z.ZodString;
    planSlug: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-plan-lifecycle">;
    project: z.ZodString;
    planSlug: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-plan-lifecycle">;
    project: z.ZodString;
    planSlug: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `share-plan` — mint a signed share token + URL with a TTL. */
export declare const SharePlan: z.ZodObject<{
    action: z.ZodLiteral<"share-plan">;
    project: z.ZodString;
    planSlug: z.ZodString;
    ttlMs: z.ZodOptional<z.ZodNumber>;
    httpPort: z.ZodOptional<z.ZodNumber>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"share-plan">;
    project: z.ZodString;
    planSlug: z.ZodString;
    ttlMs: z.ZodOptional<z.ZodNumber>;
    httpPort: z.ZodOptional<z.ZodNumber>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"share-plan">;
    project: z.ZodString;
    planSlug: z.ZodString;
    ttlMs: z.ZodOptional<z.ZodNumber>;
    httpPort: z.ZodOptional<z.ZodNumber>;
}, z.ZodTypeAny, "passthrough">>;
/** `get-plans` — list every plan, optionally scoped to one project. */
export declare const GetPlans: z.ZodObject<{
    action: z.ZodLiteral<"get-plans">;
    project: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-plans">;
    project: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-plans">;
    project: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** `get-plan` — fetch the current version + its validation + version index. */
export declare const GetPlan: z.ZodObject<{
    action: z.ZodLiteral<"get-plan">;
    project: z.ZodString;
    planSlug: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-plan">;
    project: z.ZodString;
    planSlug: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-plan">;
    project: z.ZodString;
    planSlug: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/**
 * `save-plan` — bump the plan version with a partial update.
 * `plan` is the partial body; left as `z.record(z.unknown())` because the
 * full `Plan` shape is owned by `plan-store.ts` and we don't want a circular
 * type dep from `handlers/` into `server/`.
 */
export declare const SavePlan: z.ZodObject<{
    action: z.ZodLiteral<"save-plan">;
    project: z.ZodString;
    planSlug: z.ZodString;
    plan: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"save-plan">;
    project: z.ZodString;
    planSlug: z.ZodString;
    plan: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"save-plan">;
    project: z.ZodString;
    planSlug: z.ZodString;
    plan: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, z.ZodTypeAny, "passthrough">>;
/** `validate-plan` — run the validator (optionally deep, with budget + gh lookups). */
export declare const ValidatePlan: z.ZodObject<{
    action: z.ZodLiteral<"validate-plan">;
    project: z.ZodString;
    planSlug: z.ZodString;
    deep: z.ZodOptional<z.ZodBoolean>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"validate-plan">;
    project: z.ZodString;
    planSlug: z.ZodString;
    deep: z.ZodOptional<z.ZodBoolean>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"validate-plan">;
    project: z.ZodString;
    planSlug: z.ZodString;
    deep: z.ZodOptional<z.ZodBoolean>;
}, z.ZodTypeAny, "passthrough">>;
/** `estimate-plan` — deterministic what-if estimate with repo + tier overrides. */
export declare const EstimatePlan: z.ZodObject<{
    action: z.ZodLiteral<"estimate-plan">;
    project: z.ZodString;
    planSlug: z.ZodString;
    excludeRepos: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    modelTier: z.ZodOptional<z.ZodEnum<["fast", "balanced", "thorough"]>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"estimate-plan">;
    project: z.ZodString;
    planSlug: z.ZodString;
    excludeRepos: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    modelTier: z.ZodOptional<z.ZodEnum<["fast", "balanced", "thorough"]>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"estimate-plan">;
    project: z.ZodString;
    planSlug: z.ZodString;
    excludeRepos: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    modelTier: z.ZodOptional<z.ZodEnum<["fast", "balanced", "thorough"]>>;
}, z.ZodTypeAny, "passthrough">>;
/** `regen-plan-section` — re-run a single section with the planner agent. */
export declare const RegenPlanSection: z.ZodObject<{
    action: z.ZodLiteral<"regen-plan-section">;
    project: z.ZodString;
    planSlug: z.ZodString;
    section: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"regen-plan-section">;
    project: z.ZodString;
    planSlug: z.ZodString;
    section: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"regen-plan-section">;
    project: z.ZodString;
    planSlug: z.ZodString;
    section: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>>;
}, z.ZodTypeAny, "passthrough">>;
/** `get-plan-lineage` — version index with hashes for the lineage popover. */
export declare const GetPlanLineage: z.ZodObject<{
    action: z.ZodLiteral<"get-plan-lineage">;
    project: z.ZodString;
    planSlug: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-plan-lineage">;
    project: z.ZodString;
    planSlug: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-plan-lineage">;
    project: z.ZodString;
    planSlug: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `auto-refine-plan` — user-triggered refine pass (the ONLY refine entry). */
export declare const AutoRefinePlan: z.ZodObject<{
    action: z.ZodLiteral<"auto-refine-plan">;
    project: z.ZodString;
    planSlug: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"auto-refine-plan">;
    project: z.ZodString;
    planSlug: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"auto-refine-plan">;
    project: z.ZodString;
    planSlug: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `execute-plan` — gate on validation+approval (force overrides), then start pipeline. */
export declare const ExecutePlan: z.ZodObject<{
    action: z.ZodLiteral<"execute-plan">;
    project: z.ZodString;
    planSlug: z.ZodString;
    force: z.ZodOptional<z.ZodBoolean>;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"execute-plan">;
    project: z.ZodString;
    planSlug: z.ZodString;
    force: z.ZodOptional<z.ZodBoolean>;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"execute-plan">;
    project: z.ZodString;
    planSlug: z.ZodString;
    force: z.ZodOptional<z.ZodBoolean>;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>>;
}, z.ZodTypeAny, "passthrough">>;
export type RunPlanVariantsInput = z.infer<typeof RunPlanVariants>;
export type AdoptPlanVariantInput = z.infer<typeof AdoptPlanVariant>;
export type ListPlanCommentsInput = z.infer<typeof ListPlanComments>;
export type AddPlanCommentInput = z.infer<typeof AddPlanComment>;
export type ResolvePlanCommentInput = z.infer<typeof ResolvePlanComment>;
export type DeletePlanCommentInput = z.infer<typeof DeletePlanComment>;
export type ListPlanApprovalsInput = z.infer<typeof ListPlanApprovals>;
export type ApprovePlanInput = z.infer<typeof ApprovePlan>;
export type GetPlanLifecycleInput = z.infer<typeof GetPlanLifecycle>;
export type SharePlanInput = z.infer<typeof SharePlan>;
export type GetPlansInput = z.infer<typeof GetPlans>;
export type GetPlanInput = z.infer<typeof GetPlan>;
export type SavePlanInput = z.infer<typeof SavePlan>;
export type ValidatePlanInput = z.infer<typeof ValidatePlan>;
export type EstimatePlanInput = z.infer<typeof EstimatePlan>;
export type RegenPlanSectionInput = z.infer<typeof RegenPlanSection>;
export type GetPlanLineageInput = z.infer<typeof GetPlanLineage>;
export type AutoRefinePlanInput = z.infer<typeof AutoRefinePlan>;
export type ExecutePlanInput = z.infer<typeof ExecutePlan>;
/** `run-review-pr` — kick off a PR review run with selected personas. */
export declare const RunReviewPr: z.ZodObject<{
    action: z.ZodLiteral<"run-review-pr">;
    project: z.ZodString;
    prUrl: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        personas: z.ZodOptional<z.ZodArray<z.ZodEnum<["architect", "security", "style", "tester", "domain"]>, "many">>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        personas: z.ZodOptional<z.ZodArray<z.ZodEnum<["architect", "security", "style", "tester", "domain"]>, "many">>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        personas: z.ZodOptional<z.ZodArray<z.ZodEnum<["architect", "security", "style", "tester", "domain"]>, "many">>;
    }, z.ZodTypeAny, "passthrough">>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"run-review-pr">;
    project: z.ZodString;
    prUrl: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        personas: z.ZodOptional<z.ZodArray<z.ZodEnum<["architect", "security", "style", "tester", "domain"]>, "many">>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        personas: z.ZodOptional<z.ZodArray<z.ZodEnum<["architect", "security", "style", "tester", "domain"]>, "many">>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        personas: z.ZodOptional<z.ZodArray<z.ZodEnum<["architect", "security", "style", "tester", "domain"]>, "many">>;
    }, z.ZodTypeAny, "passthrough">>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"run-review-pr">;
    project: z.ZodString;
    prUrl: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        personas: z.ZodOptional<z.ZodArray<z.ZodEnum<["architect", "security", "style", "tester", "domain"]>, "many">>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        personas: z.ZodOptional<z.ZodArray<z.ZodEnum<["architect", "security", "style", "tester", "domain"]>, "many">>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        personas: z.ZodOptional<z.ZodArray<z.ZodEnum<["architect", "security", "style", "tester", "domain"]>, "many">>;
    }, z.ZodTypeAny, "passthrough">>>;
}, z.ZodTypeAny, "passthrough">>;
/** `run-review-incremental` — re-run a review against the same PR after a push. */
export declare const RunReviewIncremental: z.ZodObject<{
    action: z.ZodLiteral<"run-review-incremental">;
    project: z.ZodString;
    reviewId: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"run-review-incremental">;
    project: z.ZodString;
    reviewId: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"run-review-incremental">;
    project: z.ZodString;
    reviewId: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        model: z.ZodOptional<z.ZodString>;
        baseBranch: z.ZodOptional<z.ZodString>;
        skipClarify: z.ZodOptional<z.ZodBoolean>;
        skipShip: z.ZodOptional<z.ZodBoolean>;
        resumeFromStage: z.ZodOptional<z.ZodNumber>;
        featureSlug: z.ZodOptional<z.ZodString>;
        failureContext: z.ZodOptional<z.ZodString>;
        planSeed: z.ZodOptional<z.ZodUnknown>;
    }, z.ZodTypeAny, "passthrough">>>;
}, z.ZodTypeAny, "passthrough">>;
/** `get-review` — fetch the current review snapshot. */
export declare const GetReview: z.ZodObject<{
    action: z.ZodLiteral<"get-review">;
    project: z.ZodString;
    reviewId: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-review">;
    project: z.ZodString;
    reviewId: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-review">;
    project: z.ZodString;
    reviewId: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `list-reviews` — list reviews (project-scoped, capped at `limit`). */
export declare const ListReviews: z.ZodObject<{
    action: z.ZodLiteral<"list-reviews">;
    project: z.ZodOptional<z.ZodString>;
    limit: z.ZodOptional<z.ZodNumber>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"list-reviews">;
    project: z.ZodOptional<z.ZodString>;
    limit: z.ZodOptional<z.ZodNumber>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"list-reviews">;
    project: z.ZodOptional<z.ZodString>;
    limit: z.ZodOptional<z.ZodNumber>;
}, z.ZodTypeAny, "passthrough">>;
/** `publish-review` — push review comments to the PR. */
export declare const PublishReview: z.ZodObject<{
    action: z.ZodLiteral<"publish-review">;
    project: z.ZodString;
    reviewId: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"publish-review">;
    project: z.ZodString;
    reviewId: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"publish-review">;
    project: z.ZodString;
    reviewId: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `resolve-review-finding` — set the resolution on a single finding. */
export declare const ResolveReviewFinding: z.ZodObject<{
    action: z.ZodLiteral<"resolve-review-finding">;
    project: z.ZodString;
    reviewId: z.ZodString;
    findingId: z.ZodString;
    resolution: z.ZodEnum<["pending", "addressed", "dismissed", "wont-fix"]>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"resolve-review-finding">;
    project: z.ZodString;
    reviewId: z.ZodString;
    findingId: z.ZodString;
    resolution: z.ZodEnum<["pending", "addressed", "dismissed", "wont-fix"]>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"resolve-review-finding">;
    project: z.ZodString;
    reviewId: z.ZodString;
    findingId: z.ZodString;
    resolution: z.ZodEnum<["pending", "addressed", "dismissed", "wont-fix"]>;
}, z.ZodTypeAny, "passthrough">>;
/** `apply-review-fix` — apply the agent-proposed fix for a finding. */
export declare const ApplyReviewFix: z.ZodObject<{
    action: z.ZodLiteral<"apply-review-fix">;
    project: z.ZodString;
    reviewId: z.ZodString;
    findingId: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"apply-review-fix">;
    project: z.ZodString;
    reviewId: z.ZodString;
    findingId: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"apply-review-fix">;
    project: z.ZodString;
    reviewId: z.ZodString;
    findingId: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `list-review-dismissals` — list dismissal-suppression keys for a project. */
export declare const ListReviewDismissals: z.ZodObject<{
    action: z.ZodLiteral<"list-review-dismissals">;
    project: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"list-review-dismissals">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"list-review-dismissals">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `reset-review-dismissal` — no-input ack (MVP-coarse re-enable). */
export declare const ResetReviewDismissal: z.ZodObject<{
    action: z.ZodLiteral<"reset-review-dismissal">;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"reset-review-dismissal">;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"reset-review-dismissal">;
}, z.ZodTypeAny, "passthrough">>;
/**
 * `apply-review-patch` — apply a proposed patch to a repo clone.
 * The validation-error response includes `findingId` (may be undefined when
 * the field is missing). Preserved verbatim from the legacy handler.
 */
export declare const ApplyReviewPatch: z.ZodObject<{
    action: z.ZodLiteral<"apply-review-patch">;
    project: z.ZodString;
    findingId: z.ZodString;
    proposedPatch: z.ZodString;
    runTests: z.ZodOptional<z.ZodBoolean>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"apply-review-patch">;
    project: z.ZodString;
    findingId: z.ZodString;
    proposedPatch: z.ZodString;
    runTests: z.ZodOptional<z.ZodBoolean>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"apply-review-patch">;
    project: z.ZodString;
    findingId: z.ZodString;
    proposedPatch: z.ZodString;
    runTests: z.ZodOptional<z.ZodBoolean>;
}, z.ZodTypeAny, "passthrough">>;
/** `get-reviewer-calibration` — empirical confidence snapshot per persona. */
export declare const GetReviewerCalibration: z.ZodObject<{
    action: z.ZodLiteral<"get-reviewer-calibration">;
    project: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-reviewer-calibration">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-reviewer-calibration">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `synthesize-review-verdict` — fold an array of findings into one verdict. */
export declare const SynthesizeReviewVerdict: z.ZodObject<{
    action: z.ZodLiteral<"synthesize-review-verdict">;
    findings: z.ZodArray<z.ZodUnknown, "many">;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"synthesize-review-verdict">;
    findings: z.ZodArray<z.ZodUnknown, "many">;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"synthesize-review-verdict">;
    findings: z.ZodArray<z.ZodUnknown, "many">;
}, z.ZodTypeAny, "passthrough">>;
export type RunReviewPrInput = z.infer<typeof RunReviewPr>;
export type RunReviewIncrementalInput = z.infer<typeof RunReviewIncremental>;
export type GetReviewInput = z.infer<typeof GetReview>;
export type ListReviewsInput = z.infer<typeof ListReviews>;
export type PublishReviewInput = z.infer<typeof PublishReview>;
export type ResolveReviewFindingInput = z.infer<typeof ResolveReviewFinding>;
export type ApplyReviewFixInput = z.infer<typeof ApplyReviewFix>;
export type ListReviewDismissalsInput = z.infer<typeof ListReviewDismissals>;
export type ApplyReviewPatchInput = z.infer<typeof ApplyReviewPatch>;
export type GetReviewerCalibrationInput = z.infer<typeof GetReviewerCalibration>;
export type SynthesizeReviewVerdictInput = z.infer<typeof SynthesizeReviewVerdict>;
/** `get-test-specs` — list specs for a project. */
export declare const GetTestSpecs: z.ZodObject<{
    action: z.ZodLiteral<"get-test-specs">;
    project: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-test-specs">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-test-specs">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `get-test-spec` — fetch a single spec by slug. */
export declare const GetTestSpec: z.ZodObject<{
    action: z.ZodLiteral<"get-test-spec">;
    project: z.ZodString;
    slug: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-test-spec">;
    project: z.ZodString;
    slug: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-test-spec">;
    project: z.ZodString;
    slug: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `get-test-cases` — fetch cases for a spec at a specific version. */
export declare const GetTestCases: z.ZodObject<{
    action: z.ZodLiteral<"get-test-cases">;
    project: z.ZodString;
    slug: z.ZodString;
    version: z.ZodNumber;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-test-cases">;
    project: z.ZodString;
    slug: z.ZodString;
    version: z.ZodNumber;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-test-cases">;
    project: z.ZodString;
    slug: z.ZodString;
    version: z.ZodNumber;
}, z.ZodTypeAny, "passthrough">>;
/** `get-test-runs` — list runs for a spec. */
export declare const GetTestRuns: z.ZodObject<{
    action: z.ZodLiteral<"get-test-runs">;
    project: z.ZodString;
    slug: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-test-runs">;
    project: z.ZodString;
    slug: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-test-runs">;
    project: z.ZodString;
    slug: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `fingerprint-test-conventions` — sniff a repo's test conventions. */
export declare const FingerprintTestConventions: z.ZodObject<{
    action: z.ZodLiteral<"fingerprint-test-conventions">;
    project: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"fingerprint-test-conventions">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"fingerprint-test-conventions">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `create-test-spec-from-plan` — derive a spec + cases from a plan. */
export declare const CreateTestSpecFromPlan: z.ZodObject<{
    action: z.ZodLiteral<"create-test-spec-from-plan">;
    project: z.ZodString;
    planSlug: z.ZodString;
    model: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"create-test-spec-from-plan">;
    project: z.ZodString;
    planSlug: z.ZodString;
    model: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"create-test-spec-from-plan">;
    project: z.ZodString;
    planSlug: z.ZodString;
    model: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** `run-test-spec` — execute a spec's cases against a repo clone. */
export declare const RunTestSpec: z.ZodObject<{
    action: z.ZodLiteral<"run-test-spec">;
    project: z.ZodString;
    slug: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"run-test-spec">;
    project: z.ZodString;
    slug: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"run-test-spec">;
    project: z.ZodString;
    slug: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `review-test-spec` — multi-persona review pass over a test run. */
export declare const ReviewTestSpec: z.ZodObject<{
    action: z.ZodLiteral<"review-test-spec">;
    project: z.ZodString;
    slug: z.ZodString;
    runId: z.ZodString;
    personas: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    model: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"review-test-spec">;
    project: z.ZodString;
    slug: z.ZodString;
    runId: z.ZodString;
    personas: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    model: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"review-test-spec">;
    project: z.ZodString;
    slug: z.ZodString;
    runId: z.ZodString;
    personas: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
    model: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** `mutation-test-spec` — run Stryker (or equivalent) against the repo. */
export declare const MutationTestSpec: z.ZodObject<{
    action: z.ZodLiteral<"mutation-test-spec">;
    project: z.ZodString;
    slug: z.ZodString;
    runId: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"mutation-test-spec">;
    project: z.ZodString;
    slug: z.ZodString;
    runId: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"mutation-test-spec">;
    project: z.ZodString;
    slug: z.ZodString;
    runId: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `polish-test-spec` — N-agent polish pass for scaffolds. */
export declare const PolishTestSpec: z.ZodObject<{
    action: z.ZodLiteral<"polish-test-spec">;
    project: z.ZodString;
    slug: z.ZodString;
    model: z.ZodOptional<z.ZodString>;
    concurrency: z.ZodOptional<z.ZodNumber>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"polish-test-spec">;
    project: z.ZodString;
    slug: z.ZodString;
    model: z.ZodOptional<z.ZodString>;
    concurrency: z.ZodOptional<z.ZodNumber>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"polish-test-spec">;
    project: z.ZodString;
    slug: z.ZodString;
    model: z.ZodOptional<z.ZodString>;
    concurrency: z.ZodOptional<z.ZodNumber>;
}, z.ZodTypeAny, "passthrough">>;
/** `resolve-test-finding` — set the resolution on a test review/flakiness finding. */
export declare const ResolveTestFinding: z.ZodObject<{
    action: z.ZodLiteral<"resolve-test-finding">;
    project: z.ZodString;
    slug: z.ZodString;
    runId: z.ZodString;
    findingId: z.ZodString;
    resolution: z.ZodEnum<["pending", "addressed", "dismissed", "wont-fix"]>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"resolve-test-finding">;
    project: z.ZodString;
    slug: z.ZodString;
    runId: z.ZodString;
    findingId: z.ZodString;
    resolution: z.ZodEnum<["pending", "addressed", "dismissed", "wont-fix"]>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"resolve-test-finding">;
    project: z.ZodString;
    slug: z.ZodString;
    runId: z.ZodString;
    findingId: z.ZodString;
    resolution: z.ZodEnum<["pending", "addressed", "dismissed", "wont-fix"]>;
}, z.ZodTypeAny, "passthrough">>;
/** `regenerate-mutation-tests` — regen behaviors against a Stryker report. */
export declare const RegenerateMutationTests: z.ZodObject<{
    action: z.ZodLiteral<"regenerate-mutation-tests">;
    project: z.ZodString;
    slug: z.ZodString;
    runId: z.ZodString;
    threshold: z.ZodOptional<z.ZodNumber>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"regenerate-mutation-tests">;
    project: z.ZodString;
    slug: z.ZodString;
    runId: z.ZodString;
    threshold: z.ZodOptional<z.ZodNumber>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"regenerate-mutation-tests">;
    project: z.ZodString;
    slug: z.ZodString;
    runId: z.ZodString;
    threshold: z.ZodOptional<z.ZodNumber>;
}, z.ZodTypeAny, "passthrough">>;
/** `generate-contract-tests` — derive contract tests from OpenAPI/proto/etc. */
export declare const GenerateContractTests: z.ZodObject<{
    action: z.ZodLiteral<"generate-contract-tests">;
    project: z.ZodString;
    slug: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"generate-contract-tests">;
    project: z.ZodString;
    slug: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"generate-contract-tests">;
    project: z.ZodString;
    slug: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** `generate-integration-scenarios` — synthesize cross-step journeys from a plan. */
export declare const GenerateIntegrationScenarios: z.ZodObject<{
    action: z.ZodLiteral<"generate-integration-scenarios">;
    project: z.ZodString;
    planSlug: z.ZodString;
    slug: z.ZodOptional<z.ZodString>;
    extraJourneys: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"generate-integration-scenarios">;
    project: z.ZodString;
    planSlug: z.ZodString;
    slug: z.ZodOptional<z.ZodString>;
    extraJourneys: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"generate-integration-scenarios">;
    project: z.ZodString;
    planSlug: z.ZodString;
    slug: z.ZodOptional<z.ZodString>;
    extraJourneys: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, z.ZodTypeAny, "passthrough">>;
/** `analyze-flakiness` — per-case flakiness investigation. */
export declare const AnalyzeFlakiness: z.ZodObject<{
    action: z.ZodLiteral<"analyze-flakiness">;
    project: z.ZodString;
    slug: z.ZodString;
    runId: z.ZodString;
    model: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"analyze-flakiness">;
    project: z.ZodString;
    slug: z.ZodString;
    runId: z.ZodString;
    model: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"analyze-flakiness">;
    project: z.ZodString;
    slug: z.ZodString;
    runId: z.ZodString;
    model: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** `publish-test-checks` — emit GitHub Checks for the run. */
export declare const PublishTestChecks: z.ZodObject<{
    action: z.ZodLiteral<"publish-test-checks">;
    project: z.ZodString;
    slug: z.ZodString;
    runId: z.ZodString;
    headSha: z.ZodString;
    repo: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"publish-test-checks">;
    project: z.ZodString;
    slug: z.ZodString;
    runId: z.ZodString;
    headSha: z.ZodString;
    repo: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"publish-test-checks">;
    project: z.ZodString;
    slug: z.ZodString;
    runId: z.ZodString;
    headSha: z.ZodString;
    repo: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `share-test-spec` — mint a signed share token + URL. */
export declare const ShareTestSpec: z.ZodObject<{
    action: z.ZodLiteral<"share-test-spec">;
    project: z.ZodString;
    slug: z.ZodString;
    ttlMs: z.ZodOptional<z.ZodNumber>;
    httpPort: z.ZodOptional<z.ZodNumber>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"share-test-spec">;
    project: z.ZodString;
    slug: z.ZodString;
    ttlMs: z.ZodOptional<z.ZodNumber>;
    httpPort: z.ZodOptional<z.ZodNumber>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"share-test-spec">;
    project: z.ZodString;
    slug: z.ZodString;
    ttlMs: z.ZodOptional<z.ZodNumber>;
    httpPort: z.ZodOptional<z.ZodNumber>;
}, z.ZodTypeAny, "passthrough">>;
/** `get-coverage-sla` — read the project's coverage SLA. */
export declare const GetCoverageSla: z.ZodObject<{
    action: z.ZodLiteral<"get-coverage-sla">;
    project: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-coverage-sla">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-coverage-sla">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/**
 * `set-coverage-sla` — write the project's SLA. `sla` shape is owned by
 * `coverage-sla.ts`; left as unknown record to avoid a circular type dep.
 */
export declare const SetCoverageSla: z.ZodObject<{
    action: z.ZodLiteral<"set-coverage-sla">;
    project: z.ZodString;
    sla: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"set-coverage-sla">;
    project: z.ZodString;
    sla: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"set-coverage-sla">;
    project: z.ZodString;
    sla: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, z.ZodTypeAny, "passthrough">>;
/** `check-coverage-sla` — compare a run against the SLA. */
export declare const CheckCoverageSla: z.ZodObject<{
    action: z.ZodLiteral<"check-coverage-sla">;
    project: z.ZodString;
    slug: z.ZodString;
    runId: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"check-coverage-sla">;
    project: z.ZodString;
    slug: z.ZodString;
    runId: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"check-coverage-sla">;
    project: z.ZodString;
    slug: z.ZodString;
    runId: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `plan-parallelization` — CI matrix planner. */
export declare const PlanParallelization: z.ZodObject<{
    action: z.ZodLiteral<"plan-parallelization">;
    project: z.ZodString;
    slug: z.ZodString;
    runner: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"plan-parallelization">;
    project: z.ZodString;
    slug: z.ZodString;
    runner: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"plan-parallelization">;
    project: z.ZodString;
    slug: z.ZodString;
    runner: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** `detect-stale-tests` — surface candidate stale tests. */
export declare const DetectStaleTests: z.ZodObject<{
    action: z.ZodLiteral<"detect-stale-tests">;
    project: z.ZodString;
    slug: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"detect-stale-tests">;
    project: z.ZodString;
    slug: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"detect-stale-tests">;
    project: z.ZodString;
    slug: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
export type GetTestSpecsInput = z.infer<typeof GetTestSpecs>;
export type GetTestSpecInput = z.infer<typeof GetTestSpec>;
export type GetTestCasesInput = z.infer<typeof GetTestCases>;
export type GetTestRunsInput = z.infer<typeof GetTestRuns>;
export type FingerprintTestConventionsInput = z.infer<typeof FingerprintTestConventions>;
export type CreateTestSpecFromPlanInput = z.infer<typeof CreateTestSpecFromPlan>;
export type RunTestSpecInput = z.infer<typeof RunTestSpec>;
export type ReviewTestSpecInput = z.infer<typeof ReviewTestSpec>;
export type MutationTestSpecInput = z.infer<typeof MutationTestSpec>;
export type PolishTestSpecInput = z.infer<typeof PolishTestSpec>;
export type ResolveTestFindingInput = z.infer<typeof ResolveTestFinding>;
export type RegenerateMutationTestsInput = z.infer<typeof RegenerateMutationTests>;
export type GenerateContractTestsInput = z.infer<typeof GenerateContractTests>;
export type GenerateIntegrationScenariosInput = z.infer<typeof GenerateIntegrationScenarios>;
export type AnalyzeFlakinessInput = z.infer<typeof AnalyzeFlakiness>;
export type PublishTestChecksInput = z.infer<typeof PublishTestChecks>;
export type ShareTestSpecInput = z.infer<typeof ShareTestSpec>;
export type GetCoverageSlaInput = z.infer<typeof GetCoverageSla>;
export type SetCoverageSlaInput = z.infer<typeof SetCoverageSla>;
export type CheckCoverageSlaInput = z.infer<typeof CheckCoverageSla>;
export type PlanParallelizationInput = z.infer<typeof PlanParallelization>;
export type DetectStaleTestsInput = z.infer<typeof DetectStaleTests>;
/** `list-incidents` — list every incident for a project. */
export declare const ListIncidents: z.ZodObject<{
    action: z.ZodLiteral<"list-incidents">;
    project: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"list-incidents">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"list-incidents">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `list-replay-queue` — optionally project-scoped replay queue snapshot. */
export declare const ListReplayQueue: z.ZodObject<{
    action: z.ZodLiteral<"list-replay-queue">;
    project: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"list-replay-queue">;
    project: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"list-replay-queue">;
    project: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** `get-incident` — fetch a single incident by id. */
export declare const GetIncident: z.ZodObject<{
    action: z.ZodLiteral<"get-incident">;
    project: z.ZodString;
    incidentId: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-incident">;
    project: z.ZodString;
    incidentId: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-incident">;
    project: z.ZodString;
    incidentId: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `get-incident-stats` — aggregate stats across incidents + replays + bound tests. */
export declare const GetIncidentStats: z.ZodObject<{
    action: z.ZodLiteral<"get-incident-stats">;
    project: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-incident-stats">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-incident-stats">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `list-replays` — replays for a project (optionally filtered by incident). */
export declare const ListReplays: z.ZodObject<{
    action: z.ZodLiteral<"list-replays">;
    project: z.ZodString;
    incidentId: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"list-replays">;
    project: z.ZodString;
    incidentId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"list-replays">;
    project: z.ZodString;
    incidentId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** `list-bound-tests` — bound-tests registry entries. */
export declare const ListBoundTests: z.ZodObject<{
    action: z.ZodLiteral<"list-bound-tests">;
    project: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"list-bound-tests">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"list-bound-tests">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/**
 * `ingest-incident` — parse an external incident into Anvil's incident store.
 * `payload` is source-specific (Sentry event JSON, incident.io event, etc.)
 * — left as `z.unknown()` to defer shape validation to the parser modules.
 */
export declare const IngestIncident: z.ZodEffects<z.ZodObject<{
    action: z.ZodLiteral<"ingest-incident">;
    project: z.ZodString;
    source: z.ZodEnum<["sentry", "incident.io", "datadog", "manual"]>;
    payload: z.ZodUnknown;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"ingest-incident">;
    project: z.ZodString;
    source: z.ZodEnum<["sentry", "incident.io", "datadog", "manual"]>;
    payload: z.ZodUnknown;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"ingest-incident">;
    project: z.ZodString;
    source: z.ZodEnum<["sentry", "incident.io", "datadog", "manual"]>;
    payload: z.ZodUnknown;
}, z.ZodTypeAny, "passthrough">>, z.objectOutputType<{
    action: z.ZodLiteral<"ingest-incident">;
    project: z.ZodString;
    source: z.ZodEnum<["sentry", "incident.io", "datadog", "manual"]>;
    payload: z.ZodUnknown;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"ingest-incident">;
    project: z.ZodString;
    source: z.ZodEnum<["sentry", "incident.io", "datadog", "manual"]>;
    payload: z.ZodUnknown;
}, z.ZodTypeAny, "passthrough">>;
/** `replay-incident` — drive the replay pipeline for an incident. */
export declare const ReplayIncident: z.ZodObject<{
    action: z.ZodLiteral<"replay-incident">;
    project: z.ZodString;
    incidentId: z.ZodString;
    specSlug: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"replay-incident">;
    project: z.ZodString;
    incidentId: z.ZodString;
    specSlug: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"replay-incident">;
    project: z.ZodString;
    incidentId: z.ZodString;
    specSlug: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** `override-bind` — remove a bound-tests entry (via replayId lookup). */
export declare const OverrideBind: z.ZodObject<{
    action: z.ZodLiteral<"override-bind">;
    project: z.ZodString;
    replayId: z.ZodString;
    reason: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"override-bind">;
    project: z.ZodString;
    replayId: z.ZodString;
    reason: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"override-bind">;
    project: z.ZodString;
    replayId: z.ZodString;
    reason: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `list-bound-audit` — recent bound-tests audit log entries. */
export declare const ListBoundAudit: z.ZodObject<{
    action: z.ZodLiteral<"list-bound-audit">;
    project: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"list-bound-audit">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"list-bound-audit">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/**
 * `override-bound-test` — remove a bound test by filePath, with audit.
 * The legacy handler enforced `reason.length >= 20` (must justify the
 * override). Preserved verbatim — `bound-override-error` carries this
 * back to the UI.
 */
export declare const OverrideBoundTest: z.ZodObject<{
    action: z.ZodLiteral<"override-bound-test">;
    project: z.ZodString;
    filePath: z.ZodString;
    reason: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"override-bound-test">;
    project: z.ZodString;
    filePath: z.ZodString;
    reason: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"override-bound-test">;
    project: z.ZodString;
    filePath: z.ZodString;
    reason: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
export type ListIncidentsInput = z.infer<typeof ListIncidents>;
export type ListReplayQueueInput = z.infer<typeof ListReplayQueue>;
export type GetIncidentInput = z.infer<typeof GetIncident>;
export type GetIncidentStatsInput = z.infer<typeof GetIncidentStats>;
export type ListReplaysInput = z.infer<typeof ListReplays>;
export type ListBoundTestsInput = z.infer<typeof ListBoundTests>;
export type IngestIncidentInput = z.infer<typeof IngestIncident>;
export type ReplayIncidentInput = z.infer<typeof ReplayIncident>;
export type OverrideBindInput = z.infer<typeof OverrideBind>;
export type ListBoundAuditInput = z.infer<typeof ListBoundAudit>;
export type OverrideBoundTestInput = z.infer<typeof OverrideBoundTest>;
/** `get-overview` — project overview (memory + KB summary + recent runs). */
export declare const GetOverview: z.ZodObject<{
    action: z.ZodLiteral<"get-overview">;
    project: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-overview">;
    project: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-overview">;
    project: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** `memory-add` — append a memory entry. */
export declare const MemoryAdd: z.ZodObject<{
    action: z.ZodLiteral<"memory-add">;
    project: z.ZodOptional<z.ZodString>;
    target: z.ZodOptional<z.ZodEnum<["memory", "user"]>>;
    content: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"memory-add">;
    project: z.ZodOptional<z.ZodString>;
    target: z.ZodOptional<z.ZodEnum<["memory", "user"]>>;
    content: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"memory-add">;
    project: z.ZodOptional<z.ZodString>;
    target: z.ZodOptional<z.ZodEnum<["memory", "user"]>>;
    content: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** `memory-replace` — replace a chunk of memory by exact-text match. */
export declare const MemoryReplace: z.ZodObject<{
    action: z.ZodLiteral<"memory-replace">;
    project: z.ZodOptional<z.ZodString>;
    target: z.ZodOptional<z.ZodEnum<["memory", "user"]>>;
    oldText: z.ZodOptional<z.ZodString>;
    content: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"memory-replace">;
    project: z.ZodOptional<z.ZodString>;
    target: z.ZodOptional<z.ZodEnum<["memory", "user"]>>;
    oldText: z.ZodOptional<z.ZodString>;
    content: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"memory-replace">;
    project: z.ZodOptional<z.ZodString>;
    target: z.ZodOptional<z.ZodEnum<["memory", "user"]>>;
    oldText: z.ZodOptional<z.ZodString>;
    content: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** `memory-remove` — delete a chunk of memory by exact-text match. */
export declare const MemoryRemove: z.ZodObject<{
    action: z.ZodLiteral<"memory-remove">;
    project: z.ZodOptional<z.ZodString>;
    target: z.ZodOptional<z.ZodEnum<["memory", "user"]>>;
    oldText: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"memory-remove">;
    project: z.ZodOptional<z.ZodString>;
    target: z.ZodOptional<z.ZodEnum<["memory", "user"]>>;
    oldText: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"memory-remove">;
    project: z.ZodOptional<z.ZodString>;
    target: z.ZodOptional<z.ZodEnum<["memory", "user"]>>;
    oldText: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** `refresh-prs` — re-poll tracked PRs from GitHub. No input. */
export declare const RefreshPRs: z.ZodObject<{
    action: z.ZodLiteral<"refresh-prs">;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"refresh-prs">;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"refresh-prs">;
}, z.ZodTypeAny, "passthrough">>;
/**
 * `get-kb-data` — KB graph report + status for a project.
 * `repo`: empty/missing = aggregate report across all repos; `'__system__'`
 * = system-level synthesis; otherwise a repo name.
 */
export declare const GetKbData: z.ZodObject<{
    action: z.ZodLiteral<"get-kb-data">;
    project: z.ZodString;
    repo: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-kb-data">;
    project: z.ZodString;
    repo: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-kb-data">;
    project: z.ZodString;
    repo: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** `query-kb` — hybrid retrieval query for context. */
export declare const QueryKb: z.ZodObject<{
    action: z.ZodLiteral<"query-kb">;
    project: z.ZodString;
    query: z.ZodString;
    maxChars: z.ZodOptional<z.ZodNumber>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"query-kb">;
    project: z.ZodString;
    query: z.ZodString;
    maxChars: z.ZodOptional<z.ZodNumber>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"query-kb">;
    project: z.ZodString;
    query: z.ZodString;
    maxChars: z.ZodOptional<z.ZodNumber>;
}, z.ZodTypeAny, "passthrough">>;
/** `get-kb-index` — keyword-prompt index for a project. */
export declare const GetKbIndex: z.ZodObject<{
    action: z.ZodLiteral<"get-kb-index">;
    project: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-kb-index">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-kb-index">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `get-kb-status` — async status snapshot (last-refresh, refreshing-now, etc). */
export declare const GetKbStatus: z.ZodObject<{
    action: z.ZodLiteral<"get-kb-status">;
    project: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-kb-status">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-kb-status">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `refresh-knowledge-base` — kick off a project-wide KB rebuild. */
export declare const RefreshKnowledgeBase: z.ZodObject<{
    action: z.ZodLiteral<"refresh-knowledge-base">;
    project: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"refresh-knowledge-base">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"refresh-knowledge-base">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `build-project-graph` — LLM-driven cross-repo graph build. */
export declare const BuildProjectGraph: z.ZodObject<{
    action: z.ZodLiteral<"build-project-graph">;
    project: z.ZodString;
    provider: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"build-project-graph">;
    project: z.ZodString;
    provider: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"build-project-graph">;
    project: z.ZodString;
    provider: z.ZodOptional<z.ZodString>;
    model: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/**
 * `get-project-graph-status` — read-only status snapshot. Legacy lenient:
 * no project still returns a synthesized empty payload, so the schema
 * makes `project` optional here.
 */
export declare const GetProjectGraphStatus: z.ZodObject<{
    action: z.ZodLiteral<"get-project-graph-status">;
    project: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-project-graph-status">;
    project: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-project-graph-status">;
    project: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** `get-graph-nodes` — graph.json data for the force-graph viz. */
export declare const GetGraphNodes: z.ZodObject<{
    action: z.ZodLiteral<"get-graph-nodes">;
    project: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        repo: z.ZodOptional<z.ZodString>;
        level: z.ZodOptional<z.ZodEnum<["project", "repo"]>>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        repo: z.ZodOptional<z.ZodString>;
        level: z.ZodOptional<z.ZodEnum<["project", "repo"]>>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        repo: z.ZodOptional<z.ZodString>;
        level: z.ZodOptional<z.ZodEnum<["project", "repo"]>>;
    }, z.ZodTypeAny, "passthrough">>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-graph-nodes">;
    project: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        repo: z.ZodOptional<z.ZodString>;
        level: z.ZodOptional<z.ZodEnum<["project", "repo"]>>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        repo: z.ZodOptional<z.ZodString>;
        level: z.ZodOptional<z.ZodEnum<["project", "repo"]>>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        repo: z.ZodOptional<z.ZodString>;
        level: z.ZodOptional<z.ZodEnum<["project", "repo"]>>;
    }, z.ZodTypeAny, "passthrough">>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-graph-nodes">;
    project: z.ZodString;
    options: z.ZodOptional<z.ZodObject<{
        repo: z.ZodOptional<z.ZodString>;
        level: z.ZodOptional<z.ZodEnum<["project", "repo"]>>;
    }, "passthrough", z.ZodTypeAny, z.objectOutputType<{
        repo: z.ZodOptional<z.ZodString>;
        level: z.ZodOptional<z.ZodEnum<["project", "repo"]>>;
    }, z.ZodTypeAny, "passthrough">, z.objectInputType<{
        repo: z.ZodOptional<z.ZodString>;
        level: z.ZodOptional<z.ZodEnum<["project", "repo"]>>;
    }, z.ZodTypeAny, "passthrough">>>;
}, z.ZodTypeAny, "passthrough">>;
export type GetOverviewInput = z.infer<typeof GetOverview>;
export type MemoryAddInput = z.infer<typeof MemoryAdd>;
export type MemoryReplaceInput = z.infer<typeof MemoryReplace>;
export type MemoryRemoveInput = z.infer<typeof MemoryRemove>;
export type GetKbDataInput = z.infer<typeof GetKbData>;
export type QueryKbInput = z.infer<typeof QueryKb>;
export type GetKbIndexInput = z.infer<typeof GetKbIndex>;
export type GetKbStatusInput = z.infer<typeof GetKbStatus>;
export type RefreshKnowledgeBaseInput = z.infer<typeof RefreshKnowledgeBase>;
export type BuildProjectGraphInput = z.infer<typeof BuildProjectGraph>;
export type GetProjectGraphStatusInput = z.infer<typeof GetProjectGraphStatus>;
export type GetGraphNodesInput = z.infer<typeof GetGraphNodes>;
/**
 * `resume-pipeline` (pause variant) and `cancel-pipeline-pause` both forward
 * the whole `msg` into `handle*` helpers from `pipeline-pauses.ts`. We only
 * read `runId` at the handler level for the side-channel emit.
 */
export declare const ResumePipelinePause: z.ZodObject<{
    action: z.ZodLiteral<"resume-pipeline">;
    runId: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"resume-pipeline">;
    runId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"resume-pipeline">;
    runId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
export declare const CancelPipelinePause: z.ZodObject<{
    action: z.ZodLiteral<"cancel-pipeline-pause">;
    runId: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"cancel-pipeline-pause">;
    runId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"cancel-pipeline-pause">;
    runId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** `get-cost-summary` — cost ledger summary for a run. */
export declare const GetCostSummary: z.ZodObject<{
    action: z.ZodLiteral<"get-cost-summary">;
    runId: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-cost-summary">;
    runId: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-cost-summary">;
    runId: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `get-cost-breach` — last breach state for a run. */
export declare const GetCostBreach: z.ZodObject<{
    action: z.ZodLiteral<"get-cost-breach">;
    runId: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-cost-breach">;
    runId: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-cost-breach">;
    runId: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `respond-cost-breach` — operator decision for a breach. */
export declare const RespondCostBreach: z.ZodObject<{
    action: z.ZodLiteral<"respond-cost-breach">;
    runId: z.ZodString;
    decision: z.ZodEnum<["raise", "reject", "extend"]>;
    deltaUsd: z.ZodOptional<z.ZodNumber>;
    extendSeconds: z.ZodOptional<z.ZodNumber>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"respond-cost-breach">;
    runId: z.ZodString;
    decision: z.ZodEnum<["raise", "reject", "extend"]>;
    deltaUsd: z.ZodOptional<z.ZodNumber>;
    extendSeconds: z.ZodOptional<z.ZodNumber>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"respond-cost-breach">;
    runId: z.ZodString;
    decision: z.ZodEnum<["raise", "reject", "extend"]>;
    deltaUsd: z.ZodOptional<z.ZodNumber>;
    extendSeconds: z.ZodOptional<z.ZodNumber>;
}, z.ZodTypeAny, "passthrough">>;
/** `subscribe-cost` — emit initial snapshot for room-based cost broadcasts. */
export declare const SubscribeCost: z.ZodObject<{
    action: z.ZodLiteral<"subscribe-cost">;
    project: z.ZodString;
    runId: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"subscribe-cost">;
    project: z.ZodString;
    runId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"subscribe-cost">;
    project: z.ZodString;
    runId: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** `get-pipeline-policy` — read merged + overlay policy for project. */
export declare const GetPipelinePolicy: z.ZodObject<{
    action: z.ZodLiteral<"get-pipeline-policy">;
    project: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-pipeline-policy">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-pipeline-policy">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/**
 * `update-pipeline-policy` — apply a patch to the cost policy. `patch` is
 * partial and matches the legacy duck-typed shape — kept as a permissive
 * record so the handler keeps owning per-field validation (e.g. the
 * graceWindowSeconds 10–600 range).
 */
export declare const UpdatePipelinePolicy: z.ZodObject<{
    action: z.ZodLiteral<"update-pipeline-policy">;
    project: z.ZodString;
    patch: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"update-pipeline-policy">;
    project: z.ZodString;
    patch: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"update-pipeline-policy">;
    project: z.ZodString;
    patch: z.ZodRecord<z.ZodString, z.ZodUnknown>;
}, z.ZodTypeAny, "passthrough">>;
/** `list-cost-breaches` — list all breach records (optionally scoped). */
export declare const ListCostBreaches: z.ZodObject<{
    action: z.ZodLiteral<"list-cost-breaches">;
    project: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"list-cost-breaches">;
    project: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"list-cost-breaches">;
    project: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** `get-plan-approval-stats` — approval/rejection counts for the project. */
export declare const GetPlanApprovalStats: z.ZodObject<{
    action: z.ZodLiteral<"get-plan-approval-stats">;
    project: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-plan-approval-stats">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-plan-approval-stats">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `list-plan-approval-records` — per-record approval log with filters. */
export declare const ListPlanApprovalRecords: z.ZodObject<{
    action: z.ZodLiteral<"list-plan-approval-records">;
    project: z.ZodString;
    limit: z.ZodOptional<z.ZodNumber>;
    since: z.ZodOptional<z.ZodString>;
    outcome: z.ZodOptional<z.ZodEnum<["approved", "modified", "rejected", "timed-out", "replanned"]>>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"list-plan-approval-records">;
    project: z.ZodString;
    limit: z.ZodOptional<z.ZodNumber>;
    since: z.ZodOptional<z.ZodString>;
    outcome: z.ZodOptional<z.ZodEnum<["approved", "modified", "rejected", "timed-out", "replanned"]>>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"list-plan-approval-records">;
    project: z.ZodString;
    limit: z.ZodOptional<z.ZodNumber>;
    since: z.ZodOptional<z.ZodString>;
    outcome: z.ZodOptional<z.ZodEnum<["approved", "modified", "rejected", "timed-out", "replanned"]>>;
}, z.ZodTypeAny, "passthrough">>;
/** `get-checkpoint-stats` — stats per (project, runFamily). */
export declare const GetCheckpointStats: z.ZodObject<{
    action: z.ZodLiteral<"get-checkpoint-stats">;
    project: z.ZodString;
    runFamily: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-checkpoint-stats">;
    project: z.ZodString;
    runFamily: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-checkpoint-stats">;
    project: z.ZodString;
    runFamily: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `get-regression-metrics` — incident/replay/bound rollup. */
export declare const GetRegressionMetrics: z.ZodObject<{
    action: z.ZodLiteral<"get-regression-metrics">;
    project: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-regression-metrics">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-regression-metrics">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `list-contracts` — discovered contracts (openapi/proto/etc) for project. */
export declare const ListContracts: z.ZodObject<{
    action: z.ZodLiteral<"list-contracts">;
    project: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"list-contracts">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"list-contracts">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `rescan-contracts` — re-discover + build contract graph. */
export declare const RescanContracts: z.ZodObject<{
    action: z.ZodLiteral<"rescan-contracts">;
    project: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"rescan-contracts">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"rescan-contracts">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `get-flakiness-clusters` — clusters + fix suggestions for flaky tests. */
export declare const GetFlakinessClusters: z.ZodObject<{
    action: z.ZodLiteral<"get-flakiness-clusters">;
    project: z.ZodString;
    specSlug: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-flakiness-clusters">;
    project: z.ZodString;
    specSlug: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-flakiness-clusters">;
    project: z.ZodString;
    specSlug: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** `rank-tests-for-pr` — relevance ranking from changed symbols. */
export declare const RankTestsForPr: z.ZodObject<{
    action: z.ZodLiteral<"rank-tests-for-pr">;
    project: z.ZodString;
    changedSymbols: z.ZodArray<z.ZodUnknown, "many">;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"rank-tests-for-pr">;
    project: z.ZodString;
    changedSymbols: z.ZodArray<z.ZodUnknown, "many">;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"rank-tests-for-pr">;
    project: z.ZodString;
    changedSymbols: z.ZodArray<z.ZodUnknown, "many">;
}, z.ZodTypeAny, "passthrough">>;
/** `analyze-ci-log` — cluster errors from a raw CI log dump. */
export declare const AnalyzeCiLog: z.ZodObject<{
    action: z.ZodLiteral<"analyze-ci-log">;
    project: z.ZodOptional<z.ZodString>;
    logText: z.ZodString;
    logSource: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"analyze-ci-log">;
    project: z.ZodOptional<z.ZodString>;
    logText: z.ZodString;
    logSource: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"analyze-ci-log">;
    project: z.ZodOptional<z.ZodString>;
    logText: z.ZodString;
    logSource: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** `fetch-ci-log` — fetch GHA log via `gh run view`. */
export declare const FetchCiLog: z.ZodObject<{
    action: z.ZodLiteral<"fetch-ci-log">;
    project: z.ZodOptional<z.ZodString>;
    logUrl: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"fetch-ci-log">;
    project: z.ZodOptional<z.ZodString>;
    logUrl: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"fetch-ci-log">;
    project: z.ZodOptional<z.ZodString>;
    logUrl: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `save-ci-triage` — persist an analysis report. Falls back to cached on ws. */
export declare const SaveCiTriage: z.ZodObject<{
    action: z.ZodLiteral<"save-ci-triage">;
    project: z.ZodString;
    ciRunId: z.ZodOptional<z.ZodString>;
    report: z.ZodOptional<z.ZodUnknown>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"save-ci-triage">;
    project: z.ZodString;
    ciRunId: z.ZodOptional<z.ZodString>;
    report: z.ZodOptional<z.ZodUnknown>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"save-ci-triage">;
    project: z.ZodString;
    ciRunId: z.ZodOptional<z.ZodString>;
    report: z.ZodOptional<z.ZodUnknown>;
}, z.ZodTypeAny, "passthrough">>;
/** `list-ci-triage` — history of saved CI triage reports. */
export declare const ListCiTriage: z.ZodObject<{
    action: z.ZodLiteral<"list-ci-triage">;
    project: z.ZodString;
    limit: z.ZodOptional<z.ZodNumber>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"list-ci-triage">;
    project: z.ZodString;
    limit: z.ZodOptional<z.ZodNumber>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"list-ci-triage">;
    project: z.ZodString;
    limit: z.ZodOptional<z.ZodNumber>;
}, z.ZodTypeAny, "passthrough">>;
export type ResumePipelinePauseInput = z.infer<typeof ResumePipelinePause>;
export type CancelPipelinePauseInput = z.infer<typeof CancelPipelinePause>;
export type GetCostSummaryInput = z.infer<typeof GetCostSummary>;
export type GetCostBreachInput = z.infer<typeof GetCostBreach>;
export type RespondCostBreachInput = z.infer<typeof RespondCostBreach>;
export type SubscribeCostInput = z.infer<typeof SubscribeCost>;
export type GetPipelinePolicyInput = z.infer<typeof GetPipelinePolicy>;
export type UpdatePipelinePolicyInput = z.infer<typeof UpdatePipelinePolicy>;
export type ListCostBreachesInput = z.infer<typeof ListCostBreaches>;
export type GetPlanApprovalStatsInput = z.infer<typeof GetPlanApprovalStats>;
export type ListPlanApprovalRecordsInput = z.infer<typeof ListPlanApprovalRecords>;
export type GetCheckpointStatsInput = z.infer<typeof GetCheckpointStats>;
export type GetRegressionMetricsInput = z.infer<typeof GetRegressionMetrics>;
export type ListContractsInput = z.infer<typeof ListContracts>;
export type RescanContractsInput = z.infer<typeof RescanContracts>;
export type GetFlakinessClustersInput = z.infer<typeof GetFlakinessClusters>;
export type RankTestsForPrInput = z.infer<typeof RankTestsForPr>;
export type AnalyzeCiLogInput = z.infer<typeof AnalyzeCiLog>;
export type FetchCiLogInput = z.infer<typeof FetchCiLog>;
export type SaveCiTriageInput = z.infer<typeof SaveCiTriage>;
export type ListCiTriageInput = z.infer<typeof ListCiTriage>;
/** `get-interrupted-pipelines` — no input. */
export declare const GetInterruptedPipelines: z.ZodObject<{
    action: z.ZodLiteral<"get-interrupted-pipelines">;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-interrupted-pipelines">;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-interrupted-pipelines">;
}, z.ZodTypeAny, "passthrough">>;
/** `get-branches` — list remote branches for a project's primary repo. */
export declare const GetBranches: z.ZodObject<{
    action: z.ZodLiteral<"get-branches">;
    project: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-branches">;
    project: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-branches">;
    project: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** `get-providers` — discovery snapshot for the Settings UI. */
export declare const GetProviders: z.ZodObject<{
    action: z.ZodLiteral<"get-providers">;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-providers">;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-providers">;
}, z.ZodTypeAny, "passthrough">>;
/** `get-available-models` — modelregistry list with per-provider availability. */
export declare const GetAvailableModels: z.ZodObject<{
    action: z.ZodLiteral<"get-available-models">;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-available-models">;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-available-models">;
}, z.ZodTypeAny, "passthrough">>;
/** `get-routing` — stage→model chain resolution for every flow. */
export declare const GetRouting: z.ZodObject<{
    action: z.ZodLiteral<"get-routing">;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-routing">;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-routing">;
}, z.ZodTypeAny, "passthrough">>;
/** `get-budget-status` — today's spend vs caps. */
export declare const GetBudgetStatus: z.ZodObject<{
    action: z.ZodLiteral<"get-budget-status">;
    project: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-budget-status">;
    project: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-budget-status">;
    project: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** `set-budget` — write cap config to factory.yaml. */
export declare const SetBudget: z.ZodObject<{
    action: z.ZodLiteral<"set-budget">;
    project: z.ZodString;
    maxPerRun: z.ZodOptional<z.ZodNumber>;
    maxPerDay: z.ZodOptional<z.ZodNumber>;
    alertAt: z.ZodOptional<z.ZodNumber>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"set-budget">;
    project: z.ZodString;
    maxPerRun: z.ZodOptional<z.ZodNumber>;
    maxPerDay: z.ZodOptional<z.ZodNumber>;
    alertAt: z.ZodOptional<z.ZodNumber>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"set-budget">;
    project: z.ZodString;
    maxPerRun: z.ZodOptional<z.ZodNumber>;
    maxPerDay: z.ZodOptional<z.ZodNumber>;
    alertAt: z.ZodOptional<z.ZodNumber>;
}, z.ZodTypeAny, "passthrough">>;
/** `get-conventions` — read convention rules for a project. */
export declare const GetConventions: z.ZodObject<{
    action: z.ZodLiteral<"get-conventions">;
    project: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-conventions">;
    project: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-conventions">;
    project: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** `get-memory-config` — read reflection mode + sleeptime interval. */
export declare const GetMemoryConfig: z.ZodObject<{
    action: z.ZodLiteral<"get-memory-config">;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-memory-config">;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-memory-config">;
}, z.ZodTypeAny, "passthrough">>;
/** `list-memories` — paginated memories list with search + stats + proposals. */
export declare const ListMemories: z.ZodObject<{
    action: z.ZodLiteral<"list-memories">;
    project: z.ZodOptional<z.ZodString>;
    search: z.ZodOptional<z.ZodString>;
    kind: z.ZodOptional<z.ZodString>;
    limit: z.ZodOptional<z.ZodNumber>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"list-memories">;
    project: z.ZodOptional<z.ZodString>;
    search: z.ZodOptional<z.ZodString>;
    kind: z.ZodOptional<z.ZodString>;
    limit: z.ZodOptional<z.ZodNumber>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"list-memories">;
    project: z.ZodOptional<z.ZodString>;
    search: z.ZodOptional<z.ZodString>;
    kind: z.ZodOptional<z.ZodString>;
    limit: z.ZodOptional<z.ZodNumber>;
}, z.ZodTypeAny, "passthrough">>;
/** `ratify-proposal` — accept a memory proposal by id. */
export declare const RatifyProposal: z.ZodObject<{
    action: z.ZodLiteral<"ratify-proposal">;
    id: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"ratify-proposal">;
    id: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"ratify-proposal">;
    id: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `reject-proposal` — reject a memory proposal with optional reason. */
export declare const RejectProposal: z.ZodObject<{
    action: z.ZodLiteral<"reject-proposal">;
    id: z.ZodString;
    reason: z.ZodOptional<z.ZodString>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"reject-proposal">;
    id: z.ZodString;
    reason: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"reject-proposal">;
    id: z.ZodString;
    reason: z.ZodOptional<z.ZodString>;
}, z.ZodTypeAny, "passthrough">>;
/** `generate-conventions` — kick off convention extraction. */
export declare const GenerateConventions: z.ZodObject<{
    action: z.ZodLiteral<"generate-conventions">;
    project: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"generate-conventions">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"generate-conventions">;
    project: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `get-auth-status` — env-var presence map for known providers. */
export declare const GetAuthStatus: z.ZodObject<{
    action: z.ZodLiteral<"get-auth-status">;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-auth-status">;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-auth-status">;
}, z.ZodTypeAny, "passthrough">>;
/** `set-auth-key` — set provider env var + persist to ~/.anvil/.env. */
export declare const SetAuthKey: z.ZodObject<{
    action: z.ZodLiteral<"set-auth-key">;
    provider: z.ZodString;
    key: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"set-auth-key">;
    provider: z.ZodString;
    key: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"set-auth-key">;
    provider: z.ZodString;
    key: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `test-auth` — lightweight API ping per provider. */
export declare const TestAuth: z.ZodObject<{
    action: z.ZodLiteral<"test-auth">;
    provider: z.ZodString;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"test-auth">;
    provider: z.ZodString;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"test-auth">;
    provider: z.ZodString;
}, z.ZodTypeAny, "passthrough">>;
/** `approve-gate` — clear pending approval. */
export declare const ApproveGate: z.ZodObject<{
    action: z.ZodLiteral<"approve-gate">;
    stage: z.ZodOptional<z.ZodNumber>;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"approve-gate">;
    stage: z.ZodOptional<z.ZodNumber>;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"approve-gate">;
    stage: z.ZodOptional<z.ZodNumber>;
}, z.ZodTypeAny, "passthrough">>;
/** `list-pipeline-pauses` — passes whole msg to handleListPauses helper. */
export declare const ListPipelinePauses: z.ZodObject<{
    action: z.ZodLiteral<"list-pipeline-pauses">;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"list-pipeline-pauses">;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"list-pipeline-pauses">;
}, z.ZodTypeAny, "passthrough">>;
/** `get-pipeline-pause` — passes whole msg to handleGetPause helper. */
export declare const GetPipelinePause: z.ZodObject<{
    action: z.ZodLiteral<"get-pipeline-pause">;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"get-pipeline-pause">;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"get-pipeline-pause">;
}, z.ZodTypeAny, "passthrough">>;
/** `unsubscribe-cost` — no-op under room-based model. */
export declare const UnsubscribeCost: z.ZodObject<{
    action: z.ZodLiteral<"unsubscribe-cost">;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"unsubscribe-cost">;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"unsubscribe-cost">;
}, z.ZodTypeAny, "passthrough">>;
/** `list-pending-breaches` — pending cost-breach decisions. */
export declare const ListPendingBreaches: z.ZodObject<{
    action: z.ZodLiteral<"list-pending-breaches">;
}, "passthrough", z.ZodTypeAny, z.objectOutputType<{
    action: z.ZodLiteral<"list-pending-breaches">;
}, z.ZodTypeAny, "passthrough">, z.objectInputType<{
    action: z.ZodLiteral<"list-pending-breaches">;
}, z.ZodTypeAny, "passthrough">>;
export type GetInterruptedPipelinesInput = z.infer<typeof GetInterruptedPipelines>;
export type GetBranchesInput = z.infer<typeof GetBranches>;
export type GetProvidersInput = z.infer<typeof GetProviders>;
export type GetAvailableModelsInput = z.infer<typeof GetAvailableModels>;
export type GetRoutingInput = z.infer<typeof GetRouting>;
export type GetBudgetStatusInput = z.infer<typeof GetBudgetStatus>;
export type SetBudgetInput = z.infer<typeof SetBudget>;
export type GetConventionsInput = z.infer<typeof GetConventions>;
export type GetMemoryConfigInput = z.infer<typeof GetMemoryConfig>;
export type ListMemoriesInput = z.infer<typeof ListMemories>;
export type RatifyProposalInput = z.infer<typeof RatifyProposal>;
export type RejectProposalInput = z.infer<typeof RejectProposal>;
export type GenerateConventionsInput = z.infer<typeof GenerateConventions>;
export type GetAuthStatusInput = z.infer<typeof GetAuthStatus>;
export type SetAuthKeyInput = z.infer<typeof SetAuthKey>;
export type TestAuthInput = z.infer<typeof TestAuth>;
export type ApproveGateInput = z.infer<typeof ApproveGate>;
export type ListPipelinePausesInput = z.infer<typeof ListPipelinePauses>;
export type GetPipelinePauseInput = z.infer<typeof GetPipelinePause>;
export type UnsubscribeCostInput = z.infer<typeof UnsubscribeCost>;
export type ListPendingBreachesInput = z.infer<typeof ListPendingBreaches>;
//# sourceMappingURL=schemas.d.ts.map