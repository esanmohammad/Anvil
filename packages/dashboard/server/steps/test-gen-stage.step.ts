/**
 * `test-gen-stage` — Phase 4f.5 of the dashboard consolidation.
 *
 * Lifts `pipeline-runner.ts:runTestGenStage()` — the deterministic
 * test-spec generator that runs after Build and before Validate. It does
 * NOT spawn an LLM agent: it fingerprints conventions, extracts behaviors
 * from the seed Plan, grounds them against the repos on disk, emits
 * test-case scaffolds, and persists `TestSpec` + `TestCase` records.
 *
 * Heavy deps (`convention-fingerprinter`, `behavior-extractor`,
 * `test-grounder`, `test-code-emitter`, `TestSpecStore`, `TestCaseStore`)
 * are dynamically imported inside the helper — same lazy-loading the
 * legacy uses to keep dashboard cold-start fast for runs that don't hit
 * the test stage.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { execSync } from 'node:child_process';

import type { Plan } from '../plan-store.js';
import type { Step, StepContext } from '@anvil/core-pipeline';

export interface TestGenArtifactEvent {
  stage: string;
  file: string;
  summary: string;
  content: string;
}

export interface RunTestGenForProjectOptions {
  /**
   * Plan from which behaviors are extracted. When undefined, the helper
   * returns the legacy "Test stage skipped (no plan seed)." message.
   */
  planSeed?: { project: string; slug: string; version: number; plan: Plan } | null;
  /** Project slug — forwarded to TestSpec / TestCase metadata. */
  project: string;
  /** Default model id captured into the TestSpec when the plan doesn't carry one. */
  model: string;
  /** Workspace root — used as the convention-fingerprint fallback when no repo exists yet. */
  workspaceDir: string;
  /** Map of repoName → absolute path. */
  repoLocalPaths: Record<string, string>;
  /**
   * Called after the helper has decided which conventions runner the
   * stage detected. Used by the legacy to seed
   * `state.stages[stageIndex].artifact = "Detected runner: <runner>\n"`.
   */
  onConventionsDetected?: (runnerLabel: string) => void;
  /**
   * Called once with the final summary so the dashboard can broadcast
   * `'artifact-written'` (legacy WS event). The helper does not emit
   * directly — the caller owns the event bus surface.
   */
  onArtifactWritten?: (event: TestGenArtifactEvent) => void;
}

interface BehaviorTargetLike {
  target: { file: string };
}

/**
 * Pick the repo whose local path contains the behavior's target file.
 * Lifted verbatim from `pipeline-runner.ts:pickRepoForBehavior()`.
 */
export function pickRepoForBehavior(
  behavior: BehaviorTargetLike,
  repoLocalPaths: Record<string, string>,
): string | null {
  const targetBase = behavior.target.file.split('/').pop() ?? '';
  for (const [repoName, path] of Object.entries(repoLocalPaths)) {
    if (!path || !existsSync(path)) continue;
    try {
      const full = join(path, behavior.target.file);
      if (existsSync(full)) return repoName;
    } catch { /* ignore */ }
  }
  if (!targetBase) return Object.keys(repoLocalPaths)[0] ?? null;
  for (const [repoName, path] of Object.entries(repoLocalPaths)) {
    if (!path || !existsSync(path)) continue;
    try {
      const found = execSync(
        `find "${path}" -name "${targetBase}" -not -path "*/node_modules/*" | head -1`,
        { encoding: 'utf-8', timeout: 5_000 },
      ).trim();
      if (found) return repoName;
    } catch { /* continue */ }
  }
  return Object.keys(repoLocalPaths)[0] ?? null;
}

/**
 * Run the deterministic test-generation stage. Returns the human-readable
 * summary string used as the stage artifact + the `'artifact-written'`
 * event payload.
 *
 * Mirrors `pipeline-runner.ts:runTestGenStage()` step-by-step:
 *   1. Fingerprint conventions on the first repo with code (or workspace).
 *   2. Extract behaviors from the plan (max 20 per repo).
 *   3. Ground behaviors against disk in all repos.
 *   4. Persist a `TestSpec` (v1 lineage).
 *   5. Emit one `TestCase` per behavior; persist via `TestCaseStore`.
 *   6. Write each test file into its target repo (skips non-anvil-generated).
 *   7. Build + return the summary string.
 */
export async function runTestGenForProject(
  opts: RunTestGenForProjectOptions,
): Promise<string> {
  if (!opts.planSeed) return 'Test stage skipped (no plan seed).';

  const { fingerprintConventions } = await import('../convention-fingerprinter.js');
  const { extractBehaviorsFromPlan } = await import('../behavior-extractor.js');
  const { groundBehaviors } = await import('../test-grounder.js');
  const { emitTestCase } = await import('../test-code-emitter.js');
  const { TestSpecStore } = await import('../test-spec-store.js');
  const { TestCaseStore } = await import('../test-case-store.js');

  const plan = opts.planSeed.plan;
  const conventions = await fingerprintConventions(
    Object.values(opts.repoLocalPaths).find((p) => existsSync(p)) ?? opts.workspaceDir,
  );
  opts.onConventionsDetected?.(`Detected runner: ${conventions.runner}\n`);

  const behaviors = extractBehaviorsFromPlan(plan, { maxPerRepo: 20 });
  if (behaviors.length === 0) {
    return `Test stage skipped (no behaviors extracted from plan ${plan.slug}).`;
  }

  const grounded = await groundBehaviors(behaviors, opts.repoLocalPaths);
  const resolvedBehaviors = grounded.map((g) => g.behavior);

  const specStore = new TestSpecStore();
  const spec = specStore.createSpec(
    opts.project,
    plan.title || plan.slug,
    plan.model ?? opts.model,
    {
      title: `Tests for ${plan.title || plan.slug}`,
      source: {
        plan: { slug: plan.slug, version: plan.version },
        files: plan.repos.flatMap((r) => r.files ?? []),
      },
      behaviors: resolvedBehaviors,
      conventions,
    },
  );

  const cases = resolvedBehaviors.map((b) =>
    emitTestCase(b, conventions, {
      specSlug: spec.slug,
      specVersion: spec.version,
      projectSlug: opts.project,
    }),
  );
  const caseStore = new TestCaseStore();
  caseStore.writeCases(opts.project, spec.slug, spec.version, cases);

  let writtenCount = 0;
  const notes: string[] = [];
  for (const c of cases) {
    const behavior = resolvedBehaviors.find((b) => b.id === c.behaviorId);
    if (!behavior) continue;
    const targetRepo = pickRepoForBehavior(behavior, opts.repoLocalPaths);
    if (!targetRepo) {
      notes.push(`- ${behavior.intent}: no repo match for target ${behavior.target.file}`);
      continue;
    }
    const fullPath = join(opts.repoLocalPaths[targetRepo], c.filePath);
    try {
      if (!existsSync(fullPath) || readFileSync(fullPath, 'utf-8').includes('// anvil-generated')) {
        mkdirSync(dirname(fullPath), { recursive: true });
        const header = `// anvil-generated — spec:${spec.slug}@v${spec.version} behavior:${c.behaviorId}\n`;
        const tmp = fullPath + '.tmp';
        writeFileSync(tmp, header + c.code, 'utf-8');
        renameSync(tmp, fullPath);
        writtenCount += 1;
      } else {
        notes.push(`- ${c.filePath}: existing hand-written test, not overwritten`);
      }
    } catch (err) {
      notes.push(`- ${c.filePath}: write failed (${err instanceof Error ? err.message : String(err)})`);
    }
  }

  const summary = [
    `Runner: ${conventions.runner} · file layout: ${conventions.fileLayout}`,
    `Behaviors extracted: ${resolvedBehaviors.length} (${resolvedBehaviors.filter((b) => b.ground.confidence >= 1).length} fully grounded)`,
    `Test cases written: ${writtenCount}/${cases.length}`,
    `Spec: ${spec.slug}@v${spec.version}`,
    notes.length ? `\nNotes:\n${notes.join('\n')}` : '',
  ].join('\n');

  opts.onArtifactWritten?.({
    stage: 'test',
    file: `tests/${spec.slug}/spec-v${spec.version}.json`,
    summary: `${writtenCount} test case${writtenCount !== 1 ? 's' : ''} generated`,
    content: summary,
  });

  return summary;
}

export interface TestGenStageStepOptions extends RunTestGenForProjectOptions {
  /** Optional Step id override; defaults to `test-gen-stage`. */
  id?: string;
}

/**
 * Step factory for the test-generation stage. NOT auto-registered —
 * Phase 4f.7 wires registration once `Pipeline.run()` becomes the
 * orchestrator. Output: the summary string.
 */
export function createTestGenStageStep(
  opts: TestGenStageStepOptions,
): Step<unknown, string> {
  const id = opts.id ?? 'test-gen-stage';
  return {
    id,
    name: 'Test generation (deterministic)',
    parallelism: 'serial',
    async run(_ctx: StepContext<unknown>): Promise<string> {
      return runTestGenForProject(opts);
    },
  };
}
