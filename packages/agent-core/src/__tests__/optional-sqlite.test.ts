/**
 * better-sqlite3 is optional: importing agent-core (and so knowledge-core,
 * which falls back to node:sqlite) must work without it. Only constructing a
 * SpendLedger needs it.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

describe('better-sqlite3 is optional', () => {
  it('agent-core imports when better-sqlite3 cannot be resolved', () => {
    const dir = mkdtempSync(join(tmpdir(), 'no-sqlite-'));
    try {
      // ESM resolve hook + a CJS require patch: both routes to better-sqlite3 fail.
      writeFileSync(join(dir, 'hook.mjs'), [
        "export async function resolve(spec, ctx, next) {",
        "  if (spec === 'better-sqlite3') throw Object.assign(new Error('blocked better-sqlite3'), { code: 'ERR_MODULE_NOT_FOUND' });",
        "  return next(spec, ctx);",
        "}",
      ].join('\n'));
      writeFileSync(join(dir, 'register.mjs'), [
        "import { register, Module } from 'node:module';",
        "register('./hook.mjs', import.meta.url);",
        "const load = Module._load;",
        "Module._load = function (req, ...rest) { if (req === 'better-sqlite3') throw new Error('blocked better-sqlite3'); return load.call(this, req, ...rest); };",
      ].join('\n'));
      const entry = pathToFileURL(join(fileURLToPath(new URL('.', import.meta.url)), '..', 'index.js')).href;
      const out = execFileSync(process.execPath, [
        '--import', pathToFileURL(join(dir, 'register.mjs')).href,
        '--input-type=module', '-e', `await import(${JSON.stringify(entry)}); console.log('imported');`,
      ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
      assert.match(out, /imported/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
