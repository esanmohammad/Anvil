/**
 * Regression: `@esankhan3/anvil-agent-core` must load when `@google/adk`
 * is absent.
 *
 * `@google/adk` is an *optional* dependency. npm drops an optional
 * dependency whenever any package in its subtree fails an install-time
 * check — on Node 20 that happens through `engines.node >= 22` on
 * `google-logging-utils` / `gcp-metadata`, deep inside ADK's tree — so a
 * consumer on Node 20 gets agent-core without ADK. A static import chain
 * `index.ts → adk-adapter.ts → adk-anthropic-llm.ts → '@google/adk'` then
 * took the whole package down with ERR_MODULE_NOT_FOUND (seen from
 * `code-search-mcp@1.0.1` on Node 20.18.3) before any adapter was chosen.
 *
 * The test runs a child Node process with a module-resolution hook that
 * refuses `@google/adk`, imports the built `index.js`, and calls
 * `AdkAdapter.checkAvailability()` — which must degrade to
 * `{ available: false }` instead of throwing at import time.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url)); // dist/__tests__
const indexUrl = pathToFileURL(join(here, '..', 'index.js')).href;

const HOOKS = `
export async function resolve(specifier, context, next) {
  if (specifier === '@google/adk' || specifier.startsWith('@google/adk/')) {
    const err = new Error("Cannot find package '@google/adk' (blocked by test)");
    err.code = 'ERR_MODULE_NOT_FOUND';
    throw err;
  }
  return next(specifier, context);
}
`;

const PROBE = `
import { AdkAdapter } from ${JSON.stringify(indexUrl)};
const result = await new AdkAdapter().checkAvailability();
console.log(JSON.stringify(result));
`;

describe('agent-core without @google/adk', () => {
  it('index.js loads and AdkAdapter degrades to available:false', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agent-core-no-adk-'));
    const hooks = join(dir, 'hooks.mjs');
    const register = join(dir, 'register.mjs');
    const probe = join(dir, 'probe.mjs');
    writeFileSync(hooks, HOOKS);
    writeFileSync(
      register,
      `import { register } from 'node:module';\nregister(${JSON.stringify(pathToFileURL(hooks).href)});\n`,
    );
    writeFileSync(probe, PROBE);

    const res = spawnSync(process.execPath, ['--import', pathToFileURL(register).href, probe], {
      encoding: 'utf8',
    });
    assert.equal(res.status, 0, `child exited ${res.status}\nstderr:\n${res.stderr}`);

    const lastLine = res.stdout.trim().split('\n').pop() ?? '';
    const out = JSON.parse(lastLine) as { available: boolean; error?: string };
    assert.equal(out.available, false);
    assert.match(out.error ?? '', /@google\/adk is not installed/);
  });
});
