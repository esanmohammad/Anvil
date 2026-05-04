/**
 * Phase 4b parity test — `feature-manifest.step` must produce the same
 * manifest patches as `pipeline-runner.ts:extractAndUpdateManifest()` for
 * every stage that has registered extractors.
 *
 * Strategy: build a fixture artifact that hits all 8 extractors, run the
 * Step factory through `Pipeline.run()`, and compare the resulting
 * `FeatureManifest` (read off disk) to the value the legacy
 * `extractAndUpdateManifest` flow would produce. Since the legacy code
 * uses the *same* extractors + `manifestStore.patchField` calls, parity
 * is verified by reading the stored manifest after each stage's Step
 * runs and asserting the field values.
 *
 * The Step is also exercised via core-pipeline's `Pipeline` so the wiring
 * (artifact:emitted bus event + ctx.input pass-through) is covered.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  InMemoryEventBus,
  InMemoryStepRegistry,
  Pipeline,
  type PipelineEvent,
  type Step,
  type StepContext,
} from '@anvil/core-pipeline';

import { FeatureStore } from '../feature-store.js';
import { FeatureManifestStore } from '../feature-manifest.js';
import {
  buildDashboardStepRegistry,
  createFeatureManifestStep,
} from '../steps/index.js';

const REQUIREMENTS_ARTIFACT = `
# Requirements

## Acceptance Criteria
- User can sign in with email and password
- Login succeeds within two seconds for typical loads
- Failed logins return a structured error code

## Affected Repos
- api
- web
`;

const SPECS_ARTIFACT = `
# Specs

## API Endpoints
- POST /api/login — issue a session token from email/password
- GET /api/session — return the current user

## Tables Touched
- read users
- alter sessions

## Test Behaviors
- A registered user logs in successfully and receives a session token
- An unknown email returns a structured 401 error
`;

const TASKS_ARTIFACT = `
## Files
- Create api/routes/login.ts
- Modify api/middleware/session.ts
- Create web/pages/login.tsx
`;

const BUILD_ARTIFACT = `
# Build

## Change Brief
Implements the login endpoint with session-token issuance and a matching
client form. Adds session-touch middleware in the api repo.
`;

const VALIDATE_ARTIFACT = `
# Validate

## Open Questions
- Should we rate-limit per-IP or per-account on failed logins?
- Token rotation cadence?
`;

interface Fixture {
  home: string;
  store: FeatureStore;
  manifestStore: FeatureManifestStore;
  project: string;
  featureSlug: string;
  cleanup: () => void;
}

function setupFixture(): Fixture {
  const home = mkdtempSync(join(tmpdir(), 'anvil-fm-step-'));
  const store = new FeatureStore(home);
  const manifestStore = new FeatureManifestStore(store);
  const project = 'demo';
  const featureSlug = 'login-feature';
  // FeatureManifestStore.write only creates the manifest file; the parent
  // feature dir must exist first. We mkdir directly so the slug stays
  // deterministic instead of relying on FeatureStore.slugify.
  mkdirSync(store.getFeatureDir(project, featureSlug), { recursive: true });
  manifestStore.ensure(project, featureSlug, 'add login');
  return {
    home,
    store,
    manifestStore,
    project,
    featureSlug,
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

async function runStepWithArtifact(
  step: Step<string, string>,
  artifact: string,
  fx: Fixture,
): Promise<{ artifacts: Array<{ id: string; data: unknown }>; output: unknown }> {
  const registry = new InMemoryStepRegistry();
  registry.register(step as Step<unknown, unknown>);

  const bus = new InMemoryEventBus();
  const artifactsEmitted: Array<{ id: string; data: unknown }> = [];
  bus.on('artifact:emitted', (event: PipelineEvent) => {
    const payload = event.payload as { artifactId: string; data: unknown } | undefined;
    if (payload) artifactsEmitted.push({ id: payload.artifactId, data: payload.data });
  });

  const pipeline = new Pipeline({
    registry,
    bus,
    runId: 'fm-step-test',
    workspaceDir: fx.home,
    initialInput: artifact,
  });
  const result = await pipeline.run();
  assert.equal(result.status, 'success');

  const seen = pipeline.getArtifacts();
  return {
    artifacts: artifactsEmitted,
    output: seen.read(seen.ids()[0] ?? ''),
  };
}

describe('createFeatureManifestStep — Phase 4b', () => {
  let fx: Fixture;

  beforeEach(() => {
    fx = setupFixture();
  });

  afterEach(() => {
    fx.cleanup();
  });

  it('extracts acceptanceCriteria + affectedRepos for the requirements stage', async () => {
    const step = createFeatureManifestStep({
      stageName: 'requirements',
      project: fx.project,
      featureSlug: fx.featureSlug,
      manifestStore: fx.manifestStore,
    });
    const { artifacts } = await runStepWithArtifact(step, REQUIREMENTS_ARTIFACT, fx);

    const manifest = fx.manifestStore.read(fx.project, fx.featureSlug);
    assert.ok(manifest);
    assert.equal(manifest.acceptanceCriteria.status, 'final');
    assert.equal(manifest.acceptanceCriteria.value?.length, 3);
    assert.equal(manifest.affectedRepos.status, 'final');
    assert.deepEqual(manifest.affectedRepos.value, ['api', 'web']);

    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].id, 'FEATURE-MANIFEST.json');
  });

  it('extracts apiEndpoints + tablesTouched + testBehaviors for specs', async () => {
    const step = createFeatureManifestStep({
      stageName: 'specs',
      project: fx.project,
      featureSlug: fx.featureSlug,
      manifestStore: fx.manifestStore,
    });
    await runStepWithArtifact(step, SPECS_ARTIFACT, fx);

    const m = fx.manifestStore.read(fx.project, fx.featureSlug);
    assert.ok(m);
    assert.ok(m.apiEndpoints.value && m.apiEndpoints.value.length >= 2);
    assert.equal(
      m.apiEndpoints.value?.find((e) => e.path === '/api/login')?.method,
      'POST',
    );
    assert.ok(m.tablesTouched.value && m.tablesTouched.value.length >= 2);
    assert.ok(m.testBehaviors.value && m.testBehaviors.value.length >= 2);
  });

  it('extracts filesPlanned for tasks', async () => {
    const step = createFeatureManifestStep({
      stageName: 'tasks',
      project: fx.project,
      featureSlug: fx.featureSlug,
      manifestStore: fx.manifestStore,
    });
    await runStepWithArtifact(step, TASKS_ARTIFACT, fx);

    const m = fx.manifestStore.read(fx.project, fx.featureSlug);
    assert.ok(m?.filesPlanned.value);
    const paths = m.filesPlanned.value.map((f) => f.path);
    assert.ok(paths.includes('api/routes/login.ts'));
    assert.ok(paths.includes('api/middleware/session.ts'));
    assert.ok(paths.includes('web/pages/login.tsx'));
  });

  it('extracts changeBrief for build', async () => {
    const step = createFeatureManifestStep({
      stageName: 'build',
      project: fx.project,
      featureSlug: fx.featureSlug,
      manifestStore: fx.manifestStore,
    });
    await runStepWithArtifact(step, BUILD_ARTIFACT, fx);

    const m = fx.manifestStore.read(fx.project, fx.featureSlug);
    assert.ok(m);
    assert.notEqual(m.changeBrief.status, 'unset');
    assert.ok(typeof m.changeBrief.value === 'string' && m.changeBrief.value.length > 10);
  });

  it('extracts openQuestions for validate', async () => {
    const step = createFeatureManifestStep({
      stageName: 'validate',
      project: fx.project,
      featureSlug: fx.featureSlug,
      manifestStore: fx.manifestStore,
    });
    await runStepWithArtifact(step, VALIDATE_ARTIFACT, fx);

    const m = fx.manifestStore.read(fx.project, fx.featureSlug);
    assert.ok(m?.openQuestions.value);
    assert.ok(m.openQuestions.value.length >= 2);
  });

  it('passes through the artifact unchanged as the Step output', async () => {
    let observed: unknown;
    const step = createFeatureManifestStep({
      stageName: 'requirements',
      project: fx.project,
      featureSlug: fx.featureSlug,
      manifestStore: fx.manifestStore,
    });
    const downstream: Step<string, void> = {
      id: 'sink',
      async run(ctx: StepContext<string>) {
        observed = ctx.input;
      },
    };

    const registry = new InMemoryStepRegistry();
    registry.register(step as Step<unknown, unknown>);
    registry.register(downstream as Step<unknown, unknown>);

    const pipeline = new Pipeline({
      registry,
      bus: new InMemoryEventBus(),
      runId: 'pass-through',
      workspaceDir: fx.home,
      initialInput: REQUIREMENTS_ARTIFACT,
    });
    await pipeline.run();
    assert.equal(observed, REQUIREMENTS_ARTIFACT);
  });

  it('no-ops cleanly for stages with no extractors and emits no artifact', async () => {
    const calls: Array<{ id: string; data: unknown }> = [];
    const bus = new InMemoryEventBus();
    bus.on('artifact:emitted', (event: PipelineEvent) => {
      const payload = event.payload as { artifactId: string; data: unknown };
      calls.push({ id: payload.artifactId, data: payload.data });
    });

    const step = createFeatureManifestStep({
      stageName: 'unknown-stage',
      project: fx.project,
      featureSlug: fx.featureSlug,
      manifestStore: fx.manifestStore,
    });
    const registry = new InMemoryStepRegistry();
    registry.register(step as Step<unknown, unknown>);

    const pipeline = new Pipeline({
      registry,
      bus,
      runId: 'noop',
      workspaceDir: fx.home,
      initialInput: 'irrelevant',
    });
    const result = await pipeline.run();
    assert.equal(result.status, 'success');
    assert.equal(calls.length, 0);
  });

  it('invokes invalidateManifestBlock when a patch lands', async () => {
    let invalidated = 0;
    const step = createFeatureManifestStep({
      stageName: 'requirements',
      project: fx.project,
      featureSlug: fx.featureSlug,
      manifestStore: fx.manifestStore,
      invalidateManifestBlock: () => {
        invalidated += 1;
      },
    });
    await runStepWithArtifact(step, REQUIREMENTS_ARTIFACT, fx);
    assert.equal(invalidated, 1);
  });

  it('does not invoke invalidateManifestBlock when nothing extracts', async () => {
    let invalidated = 0;
    const step = createFeatureManifestStep({
      stageName: 'requirements',
      project: fx.project,
      featureSlug: fx.featureSlug,
      manifestStore: fx.manifestStore,
      invalidateManifestBlock: () => {
        invalidated += 1;
      },
    });
    await runStepWithArtifact(step, '# Empty\n\nno headings here', fx);
    assert.equal(invalidated, 0);
  });

  it('catches per-extractor errors and continues with the next extractor', async () => {
    const errors: Array<{ stage: string }> = [];
    // Register a stage with a deliberately broken extractor — easiest path is
    // monkey-patching one of the manifestStore methods to throw.
    const brokenStore = new FeatureManifestStore(fx.store);
    let calls = 0;
    brokenStore.patchField = ((..._args: unknown[]) => {
      calls += 1;
      if (calls === 1) throw new Error('disk full');
      // delegate the second call so the other extractor still lands.
      return fx.manifestStore.patchField(..._args as Parameters<typeof fx.manifestStore.patchField>);
    }) as typeof brokenStore.patchField;

    const step = createFeatureManifestStep({
      stageName: 'requirements',
      project: fx.project,
      featureSlug: fx.featureSlug,
      manifestStore: brokenStore,
      onExtractorError: (stage) => errors.push({ stage }),
    });
    await runStepWithArtifact(step, REQUIREMENTS_ARTIFACT, fx);
    assert.equal(errors.length, 1);
    assert.equal(errors[0].stage, 'requirements');
    // The second extractor still landed.
    const m = fx.manifestStore.read(fx.project, fx.featureSlug);
    assert.ok(m?.affectedRepos.value);
  });
});

describe('buildDashboardStepRegistry — Phase 4b', () => {
  it('registers one feature-manifest step per FEATURE_MANIFEST_STAGES when deps are supplied', () => {
    const fx = setupFixture();
    try {
      const registry = buildDashboardStepRegistry({
        project: fx.project,
        featureSlug: fx.featureSlug,
        workspaceDir: fx.home,
        manifestStore: fx.manifestStore,
      });
      const ids = registry.steps().map((s) => s.id);
      assert.deepEqual(ids, [
        'feature-manifest:requirements',
        'feature-manifest:specs',
        'feature-manifest:tasks',
        'feature-manifest:build',
        'feature-manifest:validate',
      ]);
    } finally {
      fx.cleanup();
    }
  });

  it('skips manifest steps when featureSlug is missing', () => {
    const fx = setupFixture();
    try {
      const registry = buildDashboardStepRegistry({
        project: fx.project,
        workspaceDir: fx.home,
        manifestStore: fx.manifestStore,
      });
      assert.equal(registry.steps().length, 0);
    } finally {
      fx.cleanup();
    }
  });

  it('skips manifest steps when manifestStore is missing', () => {
    const fx = setupFixture();
    try {
      const registry = buildDashboardStepRegistry({
        project: fx.project,
        featureSlug: fx.featureSlug,
        workspaceDir: fx.home,
      });
      assert.equal(registry.steps().length, 0);
    } finally {
      fx.cleanup();
    }
  });
});
