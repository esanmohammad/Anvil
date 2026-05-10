/**
 * Process-level registry for `WebToolBackends`. Lets the harness
 * (dashboard / cli) wire web/browser backends once at boot without
 * threading them through every spawn site.
 *
 * Resolution order on each spawn:
 *   1. `request.webToolBackends` (explicit, per-spawn override).
 *   2. The process-level singleton set via `setWebToolBackends`.
 *   3. `undefined` — no web tools advertised even if the stage
 *      includes web_, browser_, or computer_use names in its allow-list.
 */

import type { WebToolBackends } from '../../tools/index.js';

let _backends: WebToolBackends | undefined;

export function setWebToolBackends(backends: WebToolBackends | undefined): void {
  _backends = backends;
}

export function getWebToolBackends(): WebToolBackends | undefined {
  return _backends;
}

export function clearWebToolBackends(): void {
  _backends = undefined;
}
