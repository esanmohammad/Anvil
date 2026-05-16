/**
 * Test-domain WS routes (Recipe 7 / Phase 1).
 *
 * Migrated (read-only):
 *   - get-test-specs   — list specs for a project
 *   - get-test-spec    — read current spec by slug (404 → `error`)
 *   - get-test-cases   — read cases for spec/version
 *   - get-test-runs    — list runs for a spec
 *
 * NOT migrated (closure-dependent — Phase 2):
 *   - run-test-spec, regen-test-spec, refine-test-case, polish-test-case,
 *     review-test-spec, fingerprint-test-conventions — all spawn pipelines
 *     or reach into the project-loader closure.
 */
import { route } from './route.js';
import * as Z from './schemas.js';
export function testRoutes() {
    return {
        'get-test-specs': route({
            input: Z.GetTestSpecs,
            onParseFail: 'silent',
            errorWireType: 'test-fingerprint-error',
            handle: (input, deps) => {
                const store = deps.extras.testSpecStore;
                if (!store)
                    return;
                return { specs: store.listSpecs(input.project) };
            },
            wireType: 'test-specs',
        }),
        'get-test-spec': route({
            input: Z.GetTestSpec,
            onParseFail: 'silent',
            handle: (input, deps) => {
                const store = deps.extras.testSpecStore;
                if (!store)
                    return;
                const spec = store.readCurrent(input.project, input.slug);
                if (!spec)
                    return { error: 'not-found' };
                return { spec };
            },
            wireType: 'test-spec',
            errorMessage: (_code, input) => `Test spec ${input.slug} not found`,
        }),
        'get-test-cases': route({
            input: Z.GetTestCases,
            onParseFail: 'silent',
            handle: (input, deps) => {
                const store = deps.extras.testCaseStore;
                if (!store)
                    return;
                return {
                    slug: input.slug,
                    version: input.version,
                    cases: store.readCases(input.project, input.slug, input.version),
                };
            },
            wireType: 'test-cases',
        }),
        'get-test-runs': route({
            input: Z.GetTestRuns,
            onParseFail: 'silent',
            handle: (input, deps) => {
                const store = deps.extras.testRunStore;
                if (!store)
                    return;
                return { slug: input.slug, runs: store.listRuns(input.project, input.slug) };
            },
            wireType: 'test-runs',
        }),
        'get-coverage-sla': route({
            input: Z.GetCoverageSla,
            onParseFail: 'silent',
            errorWireType: 'test-error',
            handle: async (input, deps) => {
                const { readProjectSLA } = await import('../coverage-sla.js');
                const sla = readProjectSLA(deps.extras.anvilHome, input.project);
                return { sla };
            },
            wireType: 'coverage-sla',
        }),
        'set-coverage-sla': route({
            input: Z.SetCoverageSla,
            onParseFail: 'silent',
            errorWireType: 'test-error',
            handle: async (input, deps) => {
                const { writeProjectSLA, readProjectSLA } = await import('../coverage-sla.js');
                writeProjectSLA(deps.extras.anvilHome, input.project, input.sla);
                const stored = readProjectSLA(deps.extras.anvilHome, input.project);
                return { sla: stored };
            },
            wireType: 'coverage-sla',
        }),
        'share-test-spec': route({
            input: Z.ShareTestSpec,
            onParseFail: 'silent',
            errorWireType: 'test-error',
            handle: async (input, deps) => {
                const store = deps.extras.testSpecStore;
                if (!store)
                    return;
                const spec = store.readCurrent(input.project, input.slug);
                if (!spec)
                    return { error: 'spec-not-found' };
                const { signTestShareToken, getOrCreateTestShareSecret, TEST_SHARE_TOKEN_TTL_MS } = await import('../test-share.js');
                const ttl = input.ttlMs ?? TEST_SHARE_TOKEN_TTL_MS;
                const secret = getOrCreateTestShareSecret(deps.extras.anvilHome);
                const expiresAt = Date.now() + ttl;
                const token = signTestShareToken({ project: spec.project, slug: spec.slug, version: spec.version, expiresAt }, secret);
                const httpPort = input.httpPort ?? 0;
                const url = httpPort ? `http://localhost:${httpPort}/share/tests/${token}` : `/share/tests/${token}`;
                return { slug: input.slug, token, url, expiresAt };
            },
            wireType: 'test-spec-shared',
            errorMessage: (_code, input) => `Spec ${input.slug} not found`,
        }),
        'check-coverage-sla': route({
            input: Z.CheckCoverageSla,
            onParseFail: 'silent',
            errorWireType: 'test-error',
            handle: async (input, deps) => {
                const runStore = deps.extras.testRunStore;
                if (!runStore)
                    return;
                const { checkCoverageSLA, readProjectSLA } = await import('../coverage-sla.js');
                const sla = readProjectSLA(deps.extras.anvilHome, input.project);
                if (!sla) {
                    // Legacy parity — emit a synthetic "pass" report rather than an error.
                    deps.ws.send(JSON.stringify({
                        type: 'coverage-sla-report',
                        payload: { report: { pass: true, violations: ['No SLA configured for this project.'] } },
                    }));
                    return;
                }
                const run = runStore.readRun(input.project, input.slug, input.runId);
                if (!run)
                    return { error: 'run-not-found' };
                const all = runStore.listRuns(input.project, input.slug);
                const prev = all.find((r) => r.id !== input.runId && r.completedAt) ?? null;
                const report = checkCoverageSLA(run, prev, sla);
                return { report };
            },
            wireType: 'coverage-sla-report',
            errorMessage: (_code, input) => `Run ${input.runId} not found`,
        }),
        'plan-parallelization': route({
            input: Z.PlanParallelization,
            onParseFail: 'silent',
            errorWireType: 'test-error',
            handle: async (input, deps) => {
                const specStore = deps.extras.testSpecStore;
                const caseStore = deps.extras.testCaseStore;
                const runStore = deps.extras.testRunStore;
                if (!specStore || !caseStore || !runStore)
                    return;
                const spec = specStore.readCurrent(input.project, input.slug);
                if (!spec)
                    return { error: 'spec-not-found' };
                const cases = caseStore.readCases(input.project, input.slug, spec.version);
                const runs = runStore.listRuns(input.project, input.slug);
                const { planParallelization, emitCIMatrix } = await import('../parallelization-planner.js');
                const plan = planParallelization(runs, cases, { targetShardDurationMs: 60_000, maxShards: 8, minShards: 1 });
                const matrix = emitCIMatrix(plan, (input.runner ?? spec.conventions?.runner));
                return { plan, matrix };
            },
            wireType: 'test-parallel-plan',
            errorMessage: (_code, input) => `Spec ${input.slug} not found`,
        }),
        'detect-stale-tests': route({
            input: Z.DetectStaleTests,
            onParseFail: 'silent',
            errorWireType: 'test-error',
            handle: async (input, deps) => {
                const specStore = deps.extras.testSpecStore;
                const caseStore = deps.extras.testCaseStore;
                const runStore = deps.extras.testRunStore;
                const loader = deps.extras.projectLoader;
                if (!specStore || !caseStore || !runStore || !loader)
                    return;
                const spec = specStore.readCurrent(input.project, input.slug);
                if (!spec)
                    return { error: 'spec-not-found' };
                const { existsSync } = await import('node:fs');
                const cases = caseStore.readCases(input.project, input.slug, spec.version);
                const runs = runStore.listRuns(input.project, input.slug);
                const repoPaths = loader.getRepoLocalPaths(input.project);
                const repoPath = Object.values(repoPaths).find((p) => p && existsSync(p));
                const { detectStaleTests } = await import('../stale-test-detector.js');
                const candidates = await detectStaleTests(runs, cases, { repoLocalPath: repoPath, runsWindow: 20, minNonFailRuns: 15 });
                return { candidates };
            },
            wireType: 'test-stale-candidates',
            errorMessage: (_code, input) => `Spec ${input.slug} not found`,
        }),
        'publish-test-checks': route({
            input: Z.PublishTestChecks,
            onParseFail: 'silent',
            errorWireType: 'test-error',
            handle: async (input, deps) => {
                const specStore = deps.extras.testSpecStore;
                const runStore = deps.extras.testRunStore;
                if (!specStore || !runStore)
                    return;
                const spec = specStore.readCurrent(input.project, input.slug);
                const run = runStore.readRun(input.project, input.slug, input.runId);
                if (!spec || !run)
                    return { error: 'spec-or-run-missing' };
                const { publishTestChecks } = await import('../test-checks-publisher.js');
                const result = await publishTestChecks({
                    repo: input.repo, headSha: input.headSha,
                    spec: spec,
                    run: run,
                    minSeverity: 'info',
                });
                return result;
            },
            wireType: 'test-checks-published',
            errorMessage: () => 'Spec or run not found',
        }),
        'rank-tests-for-pr': route({
            input: Z.RankTestsForPr,
            errorWireType: 'test-relevance-error',
            handle: async (input, deps) => {
                const loader = deps.extras.projectLoader;
                const kb = deps.extras.kbManager;
                if (!loader || !kb)
                    return;
                const { existsSync, readFileSync } = await import('node:fs');
                const { rankRelevantTests } = await import('../test-relevance-ranker.js');
                const repoPaths = loader.getRepoLocalPaths(input.project);
                const repoGraphs = {};
                for (const repoName of Object.keys(repoPaths)) {
                    try {
                        const graphPath = kb.getGraphHtmlPath(input.project, repoName);
                        if (graphPath) {
                            const graphJsonPath = graphPath.replace(/graph\.html$/, 'graph.json');
                            if (existsSync(graphJsonPath)) {
                                repoGraphs[repoName] = JSON.parse(readFileSync(graphJsonPath, 'utf-8'));
                            }
                        }
                    }
                    catch { /* ignore; some repos may not be indexed */ }
                }
                const result = rankRelevantTests({
                    changedSymbols: input.changedSymbols,
                    repoGraphs,
                });
                return { project: input.project, result };
            },
            wireType: 'test-relevance',
        }),
        'get-flakiness-clusters': route({
            input: Z.GetFlakinessClusters,
            errorWireType: 'flakiness-error',
            handle: async (input, deps) => {
                const store = deps.extras.testLearningsStore;
                if (!store)
                    return;
                const { analyzeFlakiness } = await import('../flakiness-cluster-analyzer.js');
                const { suggestFlakyFixes } = await import('../flakiness-fix-suggester.js');
                const learnings = store.read(input.project);
                const samples = (learnings?.flakyTests ?? []).map((t) => ({
                    testId: t.caseId,
                    runAt: t.lastSeen,
                    passedOnRetry: t.failureRate < 1,
                }));
                const clusters = analyzeFlakiness(samples);
                const suggestions = suggestFlakyFixes(clusters);
                return { project: input.project, specSlug: input.specSlug, clusters, suggestions };
            },
            wireType: 'flakiness-clusters',
        }),
    };
}
//# sourceMappingURL=tests.js.map