/**
 * Micro-test generator for claims with an explicit expected value.
 * Parses "should be X" / "expected Y" out of the finding message and emits
 * a tiny probe asserting equality.
 */

import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { MicroTest, VerifierLanguage } from '../review-verifier-types.js';

const SAFE_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

// Capture the thing AFTER "should be" / "expected" up to a terminator.
const EXPECT_RE = /(?:should\s+be|expected(?:\s+to\s+be)?)\s+([^.,;\n]{1,120})/i;

export interface ParsedExpectation {
  raw: string;
  normalized: string;
}

export function parseExpectation(message: string | undefined): ParsedExpectation | null {
  if (typeof message !== 'string') return null;
  const m = EXPECT_RE.exec(message);
  if (!m) return null;
  const raw = m[1].trim().replace(/["'`]|\.$/g, '');
  const normalized = raw.toLowerCase();
  if (!raw) return null;
  return { raw, normalized };
}

export function generateAssertionTest(
  finding: unknown,
  language: VerifierLanguage,
  functionName: string,
  expectation: ParsedExpectation,
): MicroTest | null {
  void finding;
  if (!functionName || !SAFE_IDENT.test(functionName)) return null;
  if (language !== 'ts' && language !== 'js') return null;

  const literal = JSON.stringify(expectation.raw);

  const source = `// Anvil R3 micro-test — assertion probe
'use strict';
const assert = require('node:assert/strict');

function ${functionName}() {
  /*__ANVIL_FN_BODY__*/
  // Placeholder: returns a sentinel so the default probe fails to match.
  return '__anvil_unmatched__';
}

const actual = ${functionName}();
try {
  assert.equal(String(actual), ${literal});
  process.stdout.write('ANVIL_REPRODUCED match=true actual=' + JSON.stringify(actual) + '\\n');
  process.exit(0);
} catch (err) {
  process.stdout.write('ANVIL_NOT_REPRODUCED actual=' + JSON.stringify(actual) + ' expected=' + ${literal} + '\\n');
  process.exit(2);
}
`;
  const filePath = resolve(tmpdir(), `anvil-assert-${safeStamp()}.cjs`);
  return {
    language,
    filePath,
    source,
    runCommand: { cmd: 'node', args: [filePath] },
  };
}

function safeStamp(): string {
  const rand = Math.floor(Math.random() * 1e9).toString(36);
  return `${Date.now().toString(36)}-${rand}`;
}
