/**
 * `test-gen-stage` step factory — deterministic test-spec generator.
 *
 * Phase H11 — promoted from
 * `packages/dashboard/server/steps/test-gen-stage.step.ts` into
 * `core-pipeline/src/steps`. Refactored to take all heavy deps
 * (convention fingerprinting, behavior extraction, grounding, code
 * emission, spec/case stores) via an injected `TestGenDeps` bundle.
 * The dashboard's wrapper supplies the FS-backed implementations.
 *
 * No LLM call — purely deterministic. Mirrors
 * `pipeline-runner.ts:runTestGenStage()` step-by-step.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { execSync } from 'node:child_process';

import type { Step, StepContext } from '../types.js';
import type { Plan } from '../utils/plan-types.js';

// ── Injected dep types ───────────────────────────────────────────────

export interface TestGenConventions {
  runner: string;
  fileLayout: string;
}

export interface TestGenBehavior {
  id: string;
  intent: string;
  target: { file: string };
  ground: { confidence: number };
}

export interface TestGenSpec {
  slug: string;
  version: number;
}

export interface TestGenCase {
  behaviorId: string;
  filePath: string;
  code: string;
}

/** Structural shape of dashboard's `TestSpecStore`. */
export interface TestSpecStoreLike {
  createSpec(
    project: string,
    title: string,
    model: string,
    payload: {
      title: string;
      source: { plan: { slug: string; version: number }; files: string[] };
      behaviors: TestGenBehavior[];
      conventions: TestGenConventions;
    },
  ): TestGenSpec;
}

/** Structural shape of dashboard's `TestCaseStore`. */
export interface TestCaseStoreLike {
  writeCases(project: string, specSlug: string, specVersion: number, cases: TestGenCase[]): void;
}

/** Bundle of injected deps the test-gen stage needs. */
export interface TestGenDeps {
  fingerprintConventions: (workspaceDir: string) => Promise<TestGenConventions>;
  extractBehaviorsFromPlan: (plan: Plan, opts: { maxPerRepo: number }) => TestGenBehavior[];
  groundBehaviors: (
    behaviors: TestGenBehavior[],
    repoLocalPaths: Record<string, string>,
  ) => Promise<Array<{ behavior: TestGenBehavior }>>;
  emitTestCase: (
    behavior: TestGenBehavior,
    conventions: TestGenConventions,
    meta: { specSlug: string; specVersion: number; projectSlug: string },
  ) => TestGenCase;
  specStore: TestSpecStoreLike;
  caseStore: TestCaseStoreLike;
}

// ── Pure helper ──────────────────────────────────────────────────────

interface BehaviorTargetLike {
  target: { file: string };
}

/**
 * Pick the repo whose local path contains the behavior's target file.
 * Pure — uses `existsSync` + `execSync` (find) which are stateless on
 * the FS layout passed in.
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

// ── Orchestrator ─────────────────────────────────────────────────────

export interface TestGenArtifactEvent {
  stage: string;
  file: string;
  summary: string;
  content: string;
}

export interface RunTestGenForProjectOptions {
  /** Plan from which behaviors are extracted. Null/undefined → skip stage. */
  planSeed?: { project: string; slug: string; version: number; plan: Plan } | null;
  project: string;
  /** Default model id captured into the TestSpec when the plan doesn't carry one. */
  model: string;
  workspaceDir: string;
  repoLocalPaths: Record<string, string>;
  /** Injected dependencies — dashboard supplies FS-backed implementations. */
  deps: TestGenDeps;
  onConventionsDetected?: (runnerLabel: string) => void;
  onArtifactWritten?: (event: TestGenArtifactEvent) => void;
}

export async function runTestGenForProject(
  opts: RunTestGenForProjectOptions,
): Promise<string> {
  if (!opts.planSeed) return 'Test stage skipped (no plan seed).';

  const { deps } = opts;
  const plan = opts.planSeed.plan;
  const conventions = await deps.fingerprintConventions(
    Object.values(opts.repoLocalPaths).find((p) => existsSync(p)) ?? opts.workspaceDir,
  );
  opts.onConventionsDetected?.(`Detected runner: ${conventions.runner}\n`);

  const behaviors = deps.extractBehaviorsFromPlan(plan, { maxPerRepo: 20 });
  if (behaviors.length === 0) {
    return `Test stage skipped (no behaviors extracted from plan ${plan.slug}).`;
  }

  const grounded = await deps.groundBehaviors(behaviors, opts.repoLocalPaths);
  const resolvedBehaviors = grounded.map((g) => g.behavior);

  const spec = deps.specStore.createSpec(
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
    deps.emitTestCase(b, conventions, {
      specSlug: spec.slug,
      specVersion: spec.version,
      projectSlug: opts.project,
    }),
  );
  deps.caseStore.writeCases(opts.project, spec.slug, spec.version, cases);

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
  id?: string;
}

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
