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
import { type Handler } from './route.js';
export declare function testRoutes(): Record<string, Handler>;
//# sourceMappingURL=tests.d.ts.map