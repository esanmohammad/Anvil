/**
 * Tests for the R3 Review verifier. Uses node:test + node:assert/strict.
 * Do NOT add explicit TS type annotations inside test function bodies.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';

import { verifyFindings } from '../review-verifier.js';

describe('verifyFindings', () => {
  it('keeps a null-deref finding whose probe reproduces the throw', async () => {
    const findings = [
      {
        file: 'src/foo.ts',
        claimType: 'null-deref',
        targetSymbol: 'greet',
        description: 'throws on null',
      },
    ];
    const out = await verifyFindings(findings, {
      repoLocalPath: tmpdir(),
      fileContents: {},
    }, { timeoutMs: 8000, concurrency: 1 });

    assert.equal(out.verified.length + out.dropped.length, 1);
    const first = out.results[0];
    assert.equal(first.verified, true, `expected verified=true, got ${JSON.stringify(first)}`);
    assert.equal(first.reproduced, true, `expected reproduced=true, got ${JSON.stringify(first)}`);
    assert.equal(out.verified.length, 1);
  });

  it("drops an assertion finding when the probe's actual value does not match", async () => {
    const findings = [
      {
        file: 'src/bar.js',
        claimType: 'other',
        targetSymbol: 'compute',
        description: 'return value should be 42',
      },
    ];
    const out = await verifyFindings(findings, {
      repoLocalPath: tmpdir(),
      fileContents: {},
    }, { timeoutMs: 8000, concurrency: 1 });

    assert.equal(out.dropped.length, 1, `expected 1 dropped, got ${JSON.stringify(out)}`);
    assert.equal(out.verified.length, 0);
    assert.equal(out.results[0].reproduced, false);
  });

  it('skips findings in unsupported languages and keeps them as-is', async () => {
    const findings = [
      {
        file: 'src/main.rs',
        claimType: 'null-deref',
        targetSymbol: 'foo',
        description: 'throws on null',
      },
    ];
    const out = await verifyFindings(findings, {
      repoLocalPath: tmpdir(),
      fileContents: {},
    }, { timeoutMs: 5000, concurrency: 1 });

    assert.equal(out.results[0].skipped, true);
    assert.equal(out.verified.length, 1);
    assert.equal(out.dropped.length, 0);
    // Finding should be returned unchanged (no verifierEvidence key added).
    assert.equal(out.verified[0], findings[0]);
  });

  it('handles a sandbox timeout without throwing', async () => {
    const findings = [
      {
        file: 'src/slow.ts',
        claimType: 'other',
        targetSymbol: 'loopForever',
        // Pick a parse-friendly "should be X" so the assertion generator fires
        // instead of the throws generator.
        description: 'return value should be eventually',
      },
    ];
    // Monkey-patch the generated source by using a tiny timeout so any probe
    // hitting the clock will time out. The assertion probe is near-instant
    // under normal conditions, so we rely on a very tight timeout to exercise
    // the timeout path deterministically on slower machines: we set it to
    // a value that is still usually achievable, and allow either a true
    // timeout OR a non-reproduction. What we assert is that the verifier
    // returns cleanly in both cases.
    const out = await verifyFindings(findings, {
      repoLocalPath: tmpdir(),
      fileContents: {},
    }, { timeoutMs: 1, concurrency: 1 });

    assert.equal(out.results.length, 1);
    const r = out.results[0];
    // Either timed out (verified=true, reproduced=false, error about timeout)
    // or ran to completion very fast but failed to reproduce. Both paths must
    // be handled without throwing and must produce a deterministic bucket.
    assert.equal(typeof r.durationMs, 'number');
    assert.equal(r.reproduced, false);
    assert.equal(out.dropped.length + out.verified.length, 1);
  });
});
