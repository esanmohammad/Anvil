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
import { type Handler } from './route.js';
export declare function testsPipelineRoutes(): Record<string, Handler>;
//# sourceMappingURL=tests-pipeline.d.ts.map