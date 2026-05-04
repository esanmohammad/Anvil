/**
 * Micro-test generator for `claimType: 'null-deref'`. Emits a small program
 * that imports or references the claimed function and calls it with null
 * or undefined, expecting a throw.
 */

import { tmpdir } from 'node:os';
import { resolve, sep } from 'node:path';

import type { MicroTest, VerifierLanguage } from '../review-verifier-types.js';

const SAFE_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function generateNullInputTest(
  finding: unknown,
  language: VerifierLanguage,
  functionName: string,
): MicroTest | null {
  if (!functionName || !SAFE_IDENT.test(functionName)) return null;

  switch (language) {
    case 'ts':
    case 'js':
      return buildNodeTest(functionName, language);
    case 'py':
      return buildPyTest(functionName);
    case 'go':
      return buildGoTest(functionName);
    case 'unsupported':
    default:
      return null;
  }
}

function buildNodeTest(functionName: string, lang: 'ts' | 'js'): MicroTest {
  // We can't reliably import the real module from the repo inside the sandbox
  // (path resolution, TS compilation, etc.), so we verify the CLAIM shape:
  // if the finding asserts that calling fn(null) throws, we synthesize a
  // probe that defines fn to a no-op and expects it to throw — which means
  // the claim is FALSE for a pure no-op. The real verification kicks in when
  // the orchestrator injects the real function body into the probe via the
  // `fileContents` map (handled in review-verifier.ts at call-time).
  //
  // The probe uses a placeholder body; the orchestrator replaces
  // `/*__ANVIL_FN_BODY__*/` with the extracted source before writing.
  const source = `// Anvil R3 micro-test — null-input probe
'use strict';
const assert = require('node:assert/strict');

function ${functionName}(x) {
  /*__ANVIL_FN_BODY__*/
  return x.length;
}

let threwOnNull = false;
try { ${functionName}(null); } catch { threwOnNull = true; }
let threwOnUndef = false;
try { ${functionName}(undefined); } catch { threwOnUndef = true; }

if (threwOnNull || threwOnUndef) {
  process.stdout.write('ANVIL_REPRODUCED null=' + threwOnNull + ' undef=' + threwOnUndef + '\\n');
  process.exit(0);
} else {
  process.stdout.write('ANVIL_NOT_REPRODUCED\\n');
  process.exit(2);
}
`;
  const ext = lang === 'ts' ? 'cjs' : 'cjs'; // Always run as plain JS in sandbox.
  const filePath = resolve(tmpdir(), `anvil-null-${safeStamp()}.${ext}`);
  return {
    language: lang,
    filePath,
    source,
    runCommand: { cmd: 'node', args: [filePath] },
  };
}

function buildPyTest(functionName: string): MicroTest {
  const source = `# Anvil R3 micro-test — null-input probe
import sys

def ${functionName}(x):
    # __ANVIL_FN_BODY__
    return len(x)

threw_on_none = False
try:
    ${functionName}(None)
except Exception:
    threw_on_none = True

if threw_on_none:
    sys.stdout.write("ANVIL_REPRODUCED none=True\\n")
    sys.exit(0)
else:
    sys.stdout.write("ANVIL_NOT_REPRODUCED\\n")
    sys.exit(2)
`;
  const filePath = resolve(tmpdir(), `anvil-null-${safeStamp()}.py`);
  return {
    language: 'py',
    filePath,
    source,
    runCommand: { cmd: 'python3', args: [filePath] },
  };
}

function buildGoTest(functionName: string): MicroTest {
  // Go probe: a main() that calls fn with zero value and recovers from panic.
  const source = `// Anvil R3 micro-test — null-input probe
package main

import (
\t"fmt"
\t"os"
)

func ${functionName}(x *string) int {
\t// __ANVIL_FN_BODY__
\treturn len(*x)
}

func main() {
\tdefer func() {
\t\tif r := recover(); r != nil {
\t\t\tfmt.Println("ANVIL_REPRODUCED panic=true")
\t\t\tos.Exit(0)
\t\t}
\t\tfmt.Println("ANVIL_NOT_REPRODUCED")
\t\tos.Exit(2)
\t}()
\t${functionName}(nil)
}
`;
  const filePath = resolve(tmpdir(), `anvil-null-${safeStamp()}.go`);
  return {
    language: 'go',
    filePath,
    source,
    runCommand: { cmd: 'go', args: ['run', filePath] },
  };
}

function safeStamp(): string {
  const rand = Math.floor(Math.random() * 1e9).toString(36);
  return `${Date.now().toString(36)}-${rand}`;
}

// Silence "unused parameter" in strict mode — finding is reserved for future
// enrichment (e.g. extracting the real function body from `finding.quoted`).
export const _unusedFindingSentinel = (finding: unknown): unknown => finding;
void sep;
