/**
 * Test pipeline routes (Phase 2.6 migration — biggest remaining cluster).
 *
 * Migrated:
 *   - fingerprint-test-conventions
 *   - create-test-spec-from-plan
 *   - run-test-spec
 *   - review-test-spec
 *   - mutation-test-spec
 *   - polish-test-spec
 *   - resolve-test-finding
 *   - regenerate-mutation-tests
 *   - generate-contract-tests
 *   - generate-integration-scenarios
 *   - analyze-flakiness
 *
 * Each handler reads from `deps.extras.unsafeStores.*` and
 * `deps.extras.agentManagerHandle`, with dynamic imports for the
 * cross-module test helpers.
 */

import { existsSync } from 'node:fs';
import { route, type Handler } from './route.js';
import * as Z from './schemas.js';
import { planAllTouchedPaths } from '@esankhan3/anvil-core-pipeline';

export function testsPipelineRoutes(): Record<string, Handler> {
  return {
    'fingerprint-test-conventions': route({
      input: Z.FingerprintTestConventions,
      onParseFail: 'silent',
      handle: async (input, deps) => {
        const projectLoader = deps.extras.projectLoader;
        if (!projectLoader) return;
        try {
          const { fingerprintConventions } = await import('../convention-fingerprinter.js');
          const repoPaths = projectLoader.getRepoLocalPaths(input.project);
          const first = Object.values(repoPaths).find((p) => p && existsSync(p));
          if (!first) {
            deps.ws.send(JSON.stringify({
              type: 'test-fingerprint-error',
              payload: { message: 'No repo clones found. Run the pipeline once first.' },
            }));
            return;
          }
          const conventions = await fingerprintConventions(first);
          deps.ws.send(JSON.stringify({ type: 'test-fingerprint', payload: { conventions } }));
        } catch (err) {
          deps.ws.send(JSON.stringify({
            type: 'test-fingerprint-error',
            payload: { message: err instanceof Error ? err.message : String(err) },
          }));
        }
      },
    }),

    'create-test-spec-from-plan': route({
      input: Z.CreateTestSpecFromPlan,
      onParseFail: 'silent',
      handle: async (input, deps) => {
        const stores = deps.extras.unsafeStores;
        const projectLoader = deps.extras.projectLoader;
        if (!stores || !projectLoader) return;
        const { project, planSlug } = input;
        const model = input.model ?? 'claude-sonnet-4-6';
        try {
          const plan = stores.planStore.readCurrent(project, planSlug);
          if (!plan) {
            deps.ws.send(JSON.stringify({
              type: 'test-spec-error',
              payload: { message: `Plan ${planSlug} not found` },
            }));
            return;
          }
          const { fingerprintConventions } = await import('../convention-fingerprinter.js');
          const { extractBehaviorsFromPlan } = await import('../behavior-extractor.js');
          const { groundBehaviors } = await import('../test-grounder.js');
          const { emitTestCase } = await import('../test-code-emitter.js');

          const repoPaths = projectLoader.getRepoLocalPaths(project);
          const first = Object.values(repoPaths).find((p) => p && existsSync(p)) ?? '';
          const conventions = await fingerprintConventions(first);

          const behaviors = extractBehaviorsFromPlan(plan, { maxPerRepo: 20 });
          const grounded = await groundBehaviors(behaviors, repoPaths);
          const resolvedBehaviors = grounded.map((g: { behavior: unknown }) => g.behavior);

          const spec = stores.testSpecStore.createSpec(project, plan.title || plan.slug, model, {
            title: `Tests for ${plan.title || plan.slug}`,
            source: {
              plan: { slug: plan.slug, version: plan.version },
              files: planAllTouchedPaths(plan),
            },
            behaviors: resolvedBehaviors,
            conventions,
          });

          const cases = resolvedBehaviors.map((b: unknown) =>
            emitTestCase(b as never, conventions, {
              specSlug: spec.slug,
              specVersion: spec.version,
              projectSlug: project,
            }),
          );
          stores.testCaseStore.writeCases(project, spec.slug, spec.version, cases);

          deps.ws.send(JSON.stringify({ type: 'test-spec-created', payload: { spec, cases } }));
        } catch (err) {
          deps.ws.send(JSON.stringify({
            type: 'test-spec-error',
            payload: { message: err instanceof Error ? err.message : String(err) },
          }));
        }
      },
    }),

    'run-test-spec': route({
      input: Z.RunTestSpec,
      onParseFail: 'silent',
      handle: async (input, deps) => {
        const stores = deps.extras.unsafeStores;
        const projectLoader = deps.extras.projectLoader;
        if (!stores || !projectLoader) return;
        const { project, slug } = input;
        try {
          const spec = stores.testSpecStore.readCurrent(project, slug);
          if (!spec) {
            deps.ws.send(JSON.stringify({
              type: 'test-run-error',
              payload: { message: `Test spec ${slug} not found` },
            }));
            return;
          }
          const cases = stores.testCaseStore.readCases(project, slug, spec.version);
          const run = stores.testRunStore.createRun(project, slug, spec.version, 'manual');
          deps.ws.send(JSON.stringify({ type: 'test-run-started', payload: { run } }));

          const repoPaths = projectLoader.getRepoLocalPaths(project);
          const repoPath = Object.values(repoPaths).find((p) => p && existsSync(p));
          if (!repoPath) {
            const completed = stores.testRunStore.updateRun(project, slug, run.id, {
              status: 'error',
              verdict: 'fail',
              completedAt: new Date().toISOString(),
              spawnError: 'No repo clone found. Run the pipeline once first.',
            });
            deps.ws.send(JSON.stringify({
              type: 'test-run-completed',
              payload: { run: completed, error: 'No repo clone found. Run the pipeline once first.' },
            }));
            return;
          }

          const { executeTestRun } = await import('../test-executor.js');
          const exec = await executeTestRun({
            project,
            repoLocalPath: repoPath,
            runner: spec.conventions.runner,
            cases,
            timeoutMs: 300_000,
            flakinessRerunCount: 2,
            onLog: (stream, line) => {
              deps.services.tests.emit('test.run-log', { runId: run.id, stream, line } as never);
            },
          });

          const aggregateSpawnError = exec.status === 'error'
            && exec.results.length > 0
            && exec.results.every((r: { pass: boolean; failure?: string }) =>
              !r.pass && r.failure && r.failure === exec.results[0].failure)
            ? exec.results[0].failure
            : undefined;

          const completed = stores.testRunStore.updateRun(project, slug, run.id, {
            status: exec.status,
            verdict: exec.verdict,
            results: exec.results,
            flakyQuarantined: exec.flakyQuarantined,
            completedAt: new Date().toISOString(),
            rawOutput: exec.rawOutput || undefined,
            spawnError: aggregateSpawnError,
          });

          for (const caseId of exec.flakyQuarantined) {
            const r = exec.results.find((x: { caseId: string; flakyScore?: number }) => x.caseId === caseId);
            if (r?.flakyScore != null) {
              try { stores.testLearningsStore.recordFlaky(project, caseId, r.flakyScore); } catch { /* ok */ }
            }
          }

          deps.ws.send(JSON.stringify({ type: 'test-run-completed', payload: { run: completed } }));
        } catch (err) {
          deps.ws.send(JSON.stringify({
            type: 'test-run-error',
            payload: { message: err instanceof Error ? err.message : String(err) },
          }));
        }
      },
    }),

    'review-test-spec': route({
      input: Z.ReviewTestSpec,
      onParseFail: 'silent',
      handle: async (input, deps) => {
        const stores = deps.extras.unsafeStores;
        const projectLoader = deps.extras.projectLoader;
        const agentManager = deps.extras.agentManagerHandle;
        if (!stores || !projectLoader || !agentManager) return;
        const { project, slug, runId, personas } = input;
        const model = input.model ?? 'claude-sonnet-4-6';
        try {
          const spec = stores.testSpecStore.readCurrent(project, slug);
          if (!spec) {
            deps.ws.send(JSON.stringify({ type: 'test-review-error', payload: { message: `Spec ${slug} not found` } }));
            return;
          }
          const cases = stores.testCaseStore.readCases(project, slug, spec.version);
          const run = stores.testRunStore.readRun(project, slug, runId);
          if (!run) {
            deps.ws.send(JSON.stringify({ type: 'test-review-error', payload: { message: `Run ${runId} not found` } }));
            return;
          }
          const repoPaths = projectLoader.getRepoLocalPaths(project);
          const cwd = Object.values(repoPaths).find((p) => p && existsSync(p)) ?? process.cwd();

          const { runMultiPersonaReview } = await import('../test-review-runner.js');
          deps.ws.send(JSON.stringify({
            type: 'test-review-started',
            payload: {
              runId,
              personas: personas ?? ['test-architect', 'edge-case-hunter', 'security-tester', 'perf-tester', 'flakiness-auditor'],
            },
          }));

          const result = await runMultiPersonaReview({
            agentManager,
            runStore: stores.testRunStore,
            learningsStore: stores.testLearningsStore,
            project,
            spec,
            cases,
            runId,
            personas: personas as never,
            model,
            cwd,
            onPersonaStart: (persona, agentId) => {
              deps.services.tests.emit('test.review-persona-start', { runId, persona, agentId } as never);
            },
            onPersonaDone: (persona, findings, cost) => {
              deps.services.tests.emit('test.review-persona-done', { runId, persona, findingCount: findings.length, cost } as never);
            },
            onError: (persona, message) => {
              deps.services.tests.emit('test.review-persona-error', { runId, persona, message } as never);
            },
          });

          const updated = stores.testRunStore.readRun(project, slug, runId);
          deps.services.tests.emit('test.review-complete', {
            runId,
            run: updated,
            totalFindings: result.findings.length,
            perPersona: Object.fromEntries(Object.entries(result.perPersonaFindings).map(([k, v]) => [k, (v as unknown[]).length])),
          } as never);
        } catch (err) {
          deps.ws.send(JSON.stringify({
            type: 'test-review-error',
            payload: { message: err instanceof Error ? err.message : String(err) },
          }));
        }
      },
    }),

    'mutation-test-spec': route({
      input: Z.MutationTestSpec,
      onParseFail: 'silent',
      handle: async (input, deps) => {
        const stores = deps.extras.unsafeStores;
        const projectLoader = deps.extras.projectLoader;
        if (!stores || !projectLoader) return;
        const { project, slug, runId } = input;
        try {
          const spec = stores.testSpecStore.readCurrent(project, slug);
          if (!spec) {
            deps.ws.send(JSON.stringify({ type: 'test-mutation-error', payload: { message: `Spec ${slug} not found` } }));
            return;
          }
          const repoPaths = projectLoader.getRepoLocalPaths(project);
          const repoPath = Object.values(repoPaths).find((p) => p && existsSync(p));
          if (!repoPath) {
            deps.ws.send(JSON.stringify({ type: 'test-mutation-error', payload: { message: 'No repo clone found.' } }));
            return;
          }
          deps.ws.send(JSON.stringify({ type: 'test-mutation-started', payload: { runId } }));
          const { runMutationTesting } = await import('../mutation-runner.js');
          const result = await runMutationTesting({
            repoLocalPath: repoPath,
            runner: spec.conventions.runner,
            timeoutMs: 600_000,
            onLog: (stream, line) => {
              deps.services.tests.emit('test.mutation-log', { runId, stream, line } as never);
            },
          });

          if (result.supported && result.score != null) {
            stores.testRunStore.updateRun(project, slug, runId, {
              mutationScore: {
                score: result.score,
                killed: result.killed,
                total: result.total,
                byFile: result.byFile,
              },
            });
            try { stores.testLearningsStore.updateMutationScore(project, result.byFile); } catch { /* ok */ }
          }
          const updated = stores.testRunStore.readRun(project, slug, runId);
          deps.ws.send(JSON.stringify({ type: 'test-mutation-complete', payload: { runId, run: updated, result } }));
        } catch (err) {
          deps.ws.send(JSON.stringify({
            type: 'test-mutation-error',
            payload: { message: err instanceof Error ? err.message : String(err) },
          }));
        }
      },
    }),

    'polish-test-spec': route({
      input: Z.PolishTestSpec,
      onParseFail: 'silent',
      handle: async (input, deps) => {
        const stores = deps.extras.unsafeStores;
        const projectLoader = deps.extras.projectLoader;
        const agentManager = deps.extras.agentManagerHandle;
        if (!stores || !projectLoader || !agentManager) return;
        const { project, slug } = input;
        const model = input.model ?? 'claude-sonnet-4-6';
        const concurrency = input.concurrency ?? 4;
        try {
          const spec = stores.testSpecStore.readCurrent(project, slug);
          if (!spec) {
            deps.ws.send(JSON.stringify({ type: 'test-polish-error', payload: { message: `Spec ${slug} not found` } }));
            return;
          }
          const cases = stores.testCaseStore.readCases(project, slug, spec.version);
          const repoPaths = projectLoader.getRepoLocalPaths(project);
          const cwd = Object.values(repoPaths).find((p) => p && existsSync(p)) ?? process.cwd();

          const { runTestAuthor } = await import('../test-author-runner.js');
          deps.ws.send(JSON.stringify({ type: 'test-polish-started', payload: { slug, caseCount: cases.length } }));

          const result = await runTestAuthor({
            agentManager,
            caseStore: stores.testCaseStore,
            learningsStore: stores.testLearningsStore,
            project,
            spec,
            cases,
            repoLocalPaths: repoPaths,
            cwd,
            model,
            concurrency,
            onlyScaffolds: true,
            onCaseStart: (caseId, agentId) => {
              deps.services.tests.emit('test.polish-case-start', { slug, caseId, agentId } as never);
            },
            onCaseDone: (caseId, updated, cost) => {
              deps.services.tests.emit('test.polish-case-done', { slug, caseId, cost, case: updated } as never);
            },
            onError: (caseId, message) => {
              deps.services.tests.emit('test.polish-case-error', { slug, caseId, message } as never);
            },
          });

          deps.ws.send(JSON.stringify({
            type: 'test-polish-complete',
            payload: {
              slug,
              polished: result.polished.length,
              skipped: result.skipped.length,
              failed: result.failed.length,
              totalCost: result.totalCost,
            },
          }));
        } catch (err) {
          deps.ws.send(JSON.stringify({
            type: 'test-polish-error',
            payload: { message: err instanceof Error ? err.message : String(err) },
          }));
        }
      },
    }),

    'resolve-test-finding': route({
      input: Z.ResolveTestFinding,
      onParseFail: 'silent',
      handle: (input, deps) => {
        const stores = deps.extras.unsafeStores;
        if (!stores) return;
        const { project, slug, runId, findingId, resolution } = input;
        const prior = stores.testRunStore.readRun(project, slug, runId);
        const priorFinding = prior?.findings.find((f: { id: string }) => f.id === findingId);
        const updated = stores.testRunStore.setResolution(project, slug, runId, findingId, resolution);
        if (!updated) {
          deps.ws.send(JSON.stringify({ type: 'error', payload: { message: 'Finding not found' } }));
          return;
        }
        const updatedFinding = updated.findings.find((f: { id: string }) => f.id === findingId);
        if (updatedFinding && priorFinding) {
          try {
            stores.testLearningsStore.recordResolution(project, updatedFinding, priorFinding.resolution);
          } catch (err) {
            console.warn('[test-gen] recordResolution failed:', err);
          }
        }
        deps.services.tests.emit('test.finding-resolved', { runId, findingId, resolution, run: updated } as never);
      },
    }),

    'regenerate-mutation-tests': route({
      input: Z.RegenerateMutationTests,
      onParseFail: 'silent',
      handle: async (input, deps) => {
        const stores = deps.extras.unsafeStores;
        const projectLoader = deps.extras.projectLoader;
        if (!stores || !projectLoader) return;
        const { project, slug, runId } = input;
        const threshold = input.threshold ?? 0.75;
        try {
          const spec = stores.testSpecStore.readCurrent(project, slug);
          if (!spec) {
            deps.ws.send(JSON.stringify({ type: 'test-error', payload: { message: `Spec ${slug} not found` } }));
            return;
          }
          const run = stores.testRunStore.readRun(project, slug, runId);
          if (!run || !run.mutationScore) {
            deps.ws.send(JSON.stringify({
              type: 'test-error',
              payload: { message: 'Run has no mutation score — run mutation testing first.' },
            }));
            return;
          }
          const repoPaths = projectLoader.getRepoLocalPaths(project);
          const repoPath = Object.values(repoPaths).find((p) => p && existsSync(p));
          if (!repoPath) {
            deps.ws.send(JSON.stringify({ type: 'test-error', payload: { message: 'No repo clone.' } }));
            return;
          }
          const { join } = await import('node:path');
          const reportPath = join(repoPath, 'reports', 'mutation', 'mutation.json');
          if (!existsSync(reportPath)) {
            deps.ws.send(JSON.stringify({
              type: 'test-error',
              payload: { message: 'Stryker report not found at reports/mutation/mutation.json' },
            }));
            return;
          }
          const { runMutationRegen, applyRegenToSpec } = await import('../mutation-regen.js');
          const regen = await runMutationRegen({
            repoLocalPath: repoPath,
            reportJsonPath: reportPath,
            scoreThreshold: threshold,
            maxNewBehaviors: 20,
            conventions: spec.conventions,
          });
          const { spec: newSpec, cases: newCases } = applyRegenToSpec({
            specStore: stores.testSpecStore,
            caseStore: stores.testCaseStore,
            project,
            specSlug: slug,
            newBehaviors: regen.newBehaviors,
            conventions: spec.conventions,
          });
          deps.services.tests.emit('test.regen-complete', {
            spec: newSpec,
            cases: newCases,
            summary: regen.summary,
            added: regen.newBehaviors.length,
          } as never);
        } catch (err) {
          deps.ws.send(JSON.stringify({
            type: 'test-error',
            payload: { message: err instanceof Error ? err.message : String(err) },
          }));
        }
      },
    }),

    'generate-contract-tests': route({
      input: Z.GenerateContractTests,
      onParseFail: 'silent',
      handle: async (input, deps) => {
        const stores = deps.extras.unsafeStores;
        const projectLoader = deps.extras.projectLoader;
        if (!stores || !projectLoader) return;
        const { project, slug } = input;
        try {
          const repoPaths = projectLoader.getRepoLocalPaths(project);
          const repoPath = Object.values(repoPaths).find((p) => p && existsSync(p));
          if (!repoPath) {
            deps.ws.send(JSON.stringify({ type: 'test-error', payload: { message: 'No repo clone.' } }));
            return;
          }
          const { discoverContractSources, generateContractBehaviors } = await import('../contract-test-gen.js');
          const sources = await discoverContractSources({ repoLocalPath: repoPath });
          const result = await generateContractBehaviors({ repoLocalPath: repoPath, sources: sources.sources });
          if (slug) {
            const current = stores.testSpecStore.readCurrent(project, slug);
            if (current) {
              const merged = [...current.behaviors, ...result.behaviors];
              const next = stores.testSpecStore.bumpVersion(project, slug, { behaviors: merged });
              const { emitTestCase } = await import('../test-code-emitter.js');
              const existing = stores.testCaseStore.readCases(project, slug, current.version);
              const newCases = result.behaviors.map((b: unknown) =>
                emitTestCase(b as never, current.conventions, { specSlug: slug, specVersion: next.version, projectSlug: project }),
              );
              stores.testCaseStore.writeCases(project, slug, next.version, [...existing, ...newCases]);
              deps.services.tests.emit('test.contract-complete', {
                spec: next,
                added: result.behaviors.length,
                bySource: result.bySource,
              } as never);
              return;
            }
          }
          deps.ws.send(JSON.stringify({
            type: 'test-contract-complete',
            payload: { sources, behaviors: result.behaviors, bySource: result.bySource },
          }));
        } catch (err) {
          deps.ws.send(JSON.stringify({
            type: 'test-error',
            payload: { message: err instanceof Error ? err.message : String(err) },
          }));
        }
      },
    }),

    'generate-integration-scenarios': route({
      input: Z.GenerateIntegrationScenarios,
      onParseFail: 'silent',
      handle: async (input, deps) => {
        const stores = deps.extras.unsafeStores;
        if (!stores) return;
        const { project, slug, planSlug, extraJourneys } = input;
        try {
          const plan = stores.planStore.readCurrent(project, planSlug);
          if (!plan) {
            deps.ws.send(JSON.stringify({ type: 'test-error', payload: { message: `Plan ${planSlug} not found` } }));
            return;
          }
          const { generateIntegrationScenarios } = await import('../integration-scenario-gen.js');
          const result = generateIntegrationScenarios({ plan, extraJourneys, maxScenarios: 12 });
          if (slug) {
            const current = stores.testSpecStore.readCurrent(project, slug);
            if (current) {
              const merged = [...current.behaviors, ...result.behaviors];
              const next = stores.testSpecStore.bumpVersion(project, slug, { behaviors: merged });
              const { emitTestCase } = await import('../test-code-emitter.js');
              const existing = stores.testCaseStore.readCases(project, slug, current.version);
              const newCases = result.behaviors.map((b: unknown) =>
                emitTestCase(b as never, current.conventions, { specSlug: slug, specVersion: next.version, projectSlug: project }),
              );
              stores.testCaseStore.writeCases(project, slug, next.version, [...existing, ...newCases]);
              deps.services.tests.emit('test.scenarios-complete', {
                spec: next,
                added: result.behaviors.length,
                derivedFrom: result.derivedFrom,
              } as never);
              return;
            }
          }
          deps.ws.send(JSON.stringify({
            type: 'test-scenarios-complete',
            payload: { behaviors: result.behaviors, derivedFrom: result.derivedFrom },
          }));
        } catch (err) {
          deps.ws.send(JSON.stringify({
            type: 'test-error',
            payload: { message: err instanceof Error ? err.message : String(err) },
          }));
        }
      },
    }),

    'analyze-flakiness': route({
      input: Z.AnalyzeFlakiness,
      onParseFail: 'silent',
      handle: async (input, deps) => {
        const stores = deps.extras.unsafeStores;
        const projectLoader = deps.extras.projectLoader;
        const agentManager = deps.extras.agentManagerHandle;
        if (!stores || !projectLoader || !agentManager) return;
        const { project, slug, runId } = input;
        const model = input.model ?? 'claude-sonnet-4-6';
        try {
          const spec = stores.testSpecStore.readCurrent(project, slug);
          if (!spec) {
            deps.ws.send(JSON.stringify({ type: 'test-error', payload: { message: `Spec ${slug} not found` } }));
            return;
          }
          const run = stores.testRunStore.readRun(project, slug, runId);
          if (!run) {
            deps.ws.send(JSON.stringify({ type: 'test-error', payload: { message: `Run ${runId} not found` } }));
            return;
          }
          const cases = stores.testCaseStore.readCases(project, slug, spec.version);
          const repoPaths = projectLoader.getRepoLocalPaths(project);
          const repoPath = Object.values(repoPaths).find((p) => p && existsSync(p));
          if (!repoPath) {
            deps.ws.send(JSON.stringify({ type: 'test-error', payload: { message: 'No repo clone.' } }));
            return;
          }
          const { analyzeFlakiness } = await import('../flakiness-analyzer.js');
          deps.ws.send(JSON.stringify({
            type: 'test-flakiness-started',
            payload: { runId, quarantinedCount: run.flakyQuarantined.length },
          }));
          const result = await analyzeFlakiness({
            agentManager,
            learningsStore: stores.testLearningsStore,
            project,
            run,
            cases,
            repoLocalPath: repoPath,
            cwd: repoPath,
            model,
            onAnalyzeStart: (caseId, agentId) =>
              deps.services.tests.emit('test.flakiness-case-start', { runId, caseId, agentId } as never),
            onAnalyzeDone: (caseId, finding) =>
              deps.services.tests.emit('test.flakiness-case-done', { runId, caseId, finding } as never),
            onError: (caseId, message) =>
              deps.services.tests.emit('test.flakiness-case-error', { runId, caseId, message } as never),
          });
          if (result.findings.length > 0) {
            stores.testRunStore.appendFindings(project, slug, runId, result.findings);
          }
          const updated = stores.testRunStore.readRun(project, slug, runId);
          deps.services.tests.emit('test.flakiness-complete', {
            runId,
            run: updated,
            findings: result.findings.length,
            signals: result.heuristicSignals,
          } as never);
        } catch (err) {
          deps.ws.send(JSON.stringify({
            type: 'test-error',
            payload: { message: err instanceof Error ? err.message : String(err) },
          }));
        }
      },
    }),
  };
}
