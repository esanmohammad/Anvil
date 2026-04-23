/**
 * Tests for review-rules/security-prepass.ts.
 *
 * One positive + one negative case per check family (secrets, injection,
 * weak crypto, open redirect, CORS). Uses node:test + node:assert —
 * matches the style of the other tests in this directory.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runSecurityPrepass } from '../review-rules/security-prepass.js';
import type {
  DiffInput,
  ReviewFinding,
} from '../review-rules/helpers.js';

// ── Helpers ─────────────────────────────────────────────────────────────

function diff(path: string, lines: string[]): DiffInput {
  return {
    files: [
      {
        path,
        addedLines: lines.map((text, i) => ({ lineNumber: i + 1, text })),
      },
    ],
  };
}

function findingsFor(
  findings: ReviewFinding[],
  predicate: (f: ReviewFinding) => boolean,
): ReviewFinding[] {
  return findings.filter(predicate);
}

// ── 1. Hardcoded secrets ────────────────────────────────────────────────

describe('runSecurityPrepass — hardcoded secrets', () => {
  it('flags an AWS access key ID as a blocker', () => {
    const input = diff('src/config.ts', [
      "const KEY = 'AKIAIOSFODNN7EXAMPLE';",
    ]);
    const out = runSecurityPrepass(input);
    const aws = findingsFor(out, (f) =>
      f.description.includes('AWS access key'),
    );
    assert.equal(aws.length, 1);
    assert.equal(aws[0].severity, 'blocker');
    assert.equal(aws[0].category, 'security');
    assert.equal(aws[0].persona, 'security');
    assert.equal(aws[0].line, 1);
    assert.ok(aws[0].suggestedFix, 'expected suggestedFix for AWS key');
  });

  it('flags a private key block and a bearer token literal', () => {
    const input = diff('src/secrets.ts', [
      '-----BEGIN RSA PRIVATE KEY-----',
      "const h = { auth: 'Bearer abcdefghijklmnopqrstuvwxyz01' };",
    ]);
    const out = runSecurityPrepass(input);
    assert.ok(
      out.some((f) => f.description.includes('Private key material')),
      'private key block missed',
    );
    assert.ok(
      out.some((f) => f.description.includes('Bearer token')),
      'bearer token missed',
    );
  });

  it('does not flag ordinary assignments without secret material', () => {
    const input = diff('src/clean.ts', [
      "const greeting = 'hello world';",
      'const n = 42;',
      "export const name = 'esan';",
    ]);
    const out = runSecurityPrepass(input);
    assert.deepEqual(out, []);
  });
});

// ── 2. Unsafe sinks / injection ─────────────────────────────────────────

describe('runSecurityPrepass — unsafe sinks', () => {
  it('flags command injection via execSync with a template literal', () => {
    const input = diff('src/run.ts', [
      'execSync(`ls ${userInput}`);',
    ]);
    const out = runSecurityPrepass(input);
    const cmd = findingsFor(out, (f) =>
      f.description.includes('Command execution'),
    );
    assert.equal(cmd.length, 1);
    assert.equal(cmd[0].severity, 'error');
    assert.equal(cmd[0].confidence, 'high');
  });

  it('flags SQL built by string interpolation', () => {
    const input = diff('src/db.ts', [
      'const q = `SELECT * FROM users WHERE id = ${userId}`;',
    ]);
    const out = runSecurityPrepass(input);
    assert.ok(
      out.some((f) => f.description.includes('SQL query built')),
      'sql injection missed',
    );
  });

  it('does not flag a constant SQL string with no interpolation', () => {
    const input = diff('src/db.ts', [
      "const q = 'SELECT 1';",
      "const list = 'SELECT id, name FROM users';",
    ]);
    const out = runSecurityPrepass(input);
    const sql = findingsFor(out, (f) =>
      f.description.includes('SQL query built'),
    );
    assert.equal(sql.length, 0);
  });
});

// ── 3. Weak crypto ──────────────────────────────────────────────────────

describe('runSecurityPrepass — weak crypto', () => {
  it('flags createHash("md5")', () => {
    const input = diff('src/hash.ts', [
      "const h = crypto.createHash('md5');",
    ]);
    const out = runSecurityPrepass(input);
    const weak = findingsFor(out, (f) =>
      f.description.includes('Weak hash algorithm'),
    );
    assert.equal(weak.length, 1);
    assert.equal(weak[0].severity, 'warn');
  });

  it('flags Math.random() only when near a token/secret keyword', () => {
    const positive = diff('src/token.ts', [
      'const token = Math.random().toString(36);',
    ]);
    const negative = diff('src/ui.ts', [
      'const dx = Math.random() * 10;',
    ]);

    const posOut = runSecurityPrepass(positive);
    const negOut = runSecurityPrepass(negative);

    assert.ok(
      posOut.some((f) => f.description.includes('Math.random()')),
      'token-context Math.random() should be flagged',
    );
    assert.ok(
      !negOut.some((f) => f.description.includes('Math.random()')),
      'non-security Math.random() should NOT be flagged',
    );
  });
});

// ── 4. Open redirect ────────────────────────────────────────────────────

describe('runSecurityPrepass — open redirect', () => {
  it('flags res.redirect(req.query....)', () => {
    const input = diff('src/routes.ts', [
      'app.get("/go", (req, res) => res.redirect(req.query.next));',
    ]);
    const out = runSecurityPrepass(input);
    assert.ok(
      out.some((f) => f.description.includes('Redirect target is user-controlled')),
    );
  });

  it('does not flag a redirect to a constant path', () => {
    const input = diff('src/routes.ts', [
      'res.redirect("/login");',
    ]);
    const out = runSecurityPrepass(input);
    const open = findingsFor(out, (f) =>
      f.description.includes('Redirect target is user-controlled'),
    );
    assert.equal(open.length, 0);
  });
});

// ── 5. CORS ─────────────────────────────────────────────────────────────

describe('runSecurityPrepass — CORS', () => {
  it('flags Access-Control-Allow-Origin: *', () => {
    const input = diff('src/cors.ts', [
      "res.setHeader('Access-Control-Allow-Origin', '*');",
    ]);
    const out = runSecurityPrepass(input);
    assert.ok(
      out.some((f) => f.description.includes('Wildcard `Access-Control-Allow-Origin')),
    );
  });

  it('does not flag a specific origin', () => {
    const input = diff('src/cors.ts', [
      "res.setHeader('Access-Control-Allow-Origin', 'https://app.example.com');",
    ]);
    const out = runSecurityPrepass(input);
    const cors = findingsFor(out, (f) =>
      f.description.includes('Wildcard `Access-Control-Allow-Origin'),
    );
    assert.equal(cors.length, 0);
  });
});
