/**
 * Phase D5 — `lintStepSource` static analyzer.
 *
 * The analyzer flags direct side-effect calls inside step bodies
 * (the durable execution invariant: every external touch must go
 * through `ctx.effect`). Confirms it catches the seven canonical
 * patterns and survives commented-out lines.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { lintStepSource } from '../durable/lint.js';

describe('lintStepSource', () => {
  it('flags Date.now()', () => {
    const out = lintStepSource('const t = Date.now();');
    assert.equal(out.length, 1);
    assert.equal(out[0].rule, 'no-direct-date-now');
    assert.equal(out[0].suggestion, 'await ctx.now()');
  });

  it('flags Math.random()', () => {
    const out = lintStepSource('const r = Math.random();');
    assert.equal(out.length, 1);
    assert.equal(out[0].rule, 'no-direct-math-random');
  });

  it('flags crypto.randomUUID + bare randomUUID', () => {
    const out = lintStepSource('const a = randomUUID(); const b = crypto.randomUUID();');
    assert.equal(out.length, 2);
    assert.deepEqual(out.map((v) => v.rule), ['no-direct-crypto-uuid', 'no-direct-crypto-uuid']);
  });

  it('flags writeFile / writeFileSync / appendFile', () => {
    const out = lintStepSource(
      'writeFile("a"); writeFileSync("b"); appendFile("c"); appendFileSync("d");',
    );
    assert.equal(out.length, 4);
  });

  it('flags exec / execSync / execFile / spawn', () => {
    const out = lintStepSource(
      'exec("a"); execSync("b"); execFile("c", []); spawn("d");',
    );
    assert.equal(out.length, 4);
  });

  it('flags setTimeout', () => {
    const out = lintStepSource('setTimeout(() => x, 100);');
    assert.equal(out.length, 1);
    assert.equal(out[0].rule, 'no-direct-setTimeout');
  });

  it('skips commented-out lines', () => {
    const src = `
      // const t = Date.now();
      /* writeFile("a"); */
      * Math.random()
    `;
    const out = lintStepSource(src);
    assert.equal(out.length, 0);
  });

  it('flags violations with correct line numbers', () => {
    const src = ['line one', 'const t = Date.now();', '', 'Math.random();'].join('\n');
    const out = lintStepSource(src);
    assert.equal(out.length, 2);
    assert.equal(out[0].line, 2);
    assert.equal(out[1].line, 4);
  });

  it('returns empty for clean step bodies', () => {
    const src = `
      async function run(ctx) {
        const t = await ctx.now();
        const r = await ctx.random();
        const v = await ctx.effect('foo', async () => 42);
        return v + t + r;
      }
    `;
    assert.deepEqual(lintStepSource(src), []);
  });
});
