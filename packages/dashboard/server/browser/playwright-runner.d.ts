/**
 * Playwright-driven browser runner. Used in production. The `playwright`
 * package is dynamically imported so installations without it (CI fast
 * lane, lightweight dev shells) still load this module — `createPlaywrightRunner`
 * just rejects with a clear error.
 *
 * For now we expose a minimal subset (navigate/click/input/scroll/snapshot
 * + close). Extract/screenshot/console/network land in Phase H5.
 */
import type { BrowserRunner, BrowserSessionOpts } from './session-manager.js';
export declare function createPlaywrightRunner(opts: BrowserSessionOpts): Promise<BrowserRunner>;
//# sourceMappingURL=playwright-runner.d.ts.map