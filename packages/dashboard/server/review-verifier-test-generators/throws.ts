/**
 * Micro-test generator for `claimType: 'other'` where the finding message
 * asserts the code throws/raises/panics. Emits a minimal probe that calls
 * the function and asserts a throw.
 */

import { tmpdir } from 'node:os';
import { resolve } from 'node:path';

import type { MicroTest, VerifierLanguage } from '../review-verifier-types.js';

const SAFE_IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const THROW_WORDS = /(throws?|raises?|panics?)/i;

export function claimMentionsThrow(message: string | undefined): boolean {
  if (typeof message !== 'string') return false;
  return THROW_WORDS.test(message);
}

export function generateThrowsTest(
  finding: unknown,
  language: VerifierLanguage,
  functionName: string,
): MicroTest | null {
  void finding;
  if (!functionName || !SAFE_IDENT.test(functionName)) return null;

  switch (language) {
    case 'ts':
    case 'js':
      return buildNodeThrowsTest(functionName, language);
    case 'py':
      return buildPyThrowsTest(functionName);
    case 'go':
      return buildGoThrowsTest(functionName);
    default:
      return null;
  }
}

function buildNodeThrowsTest(functionName: string, lang: 'ts' | 'js'): MicroTest {
  const source = `// Anvil R3 micro-test — throws probe
'use strict';

function ${functionName}() {
  /*__ANVIL_FN_BODY__*/
  // Default placeholder body: does NOT throw.
  return 0;
}

let threw = false;
let msg = '';
try { ${functionName}(); } catch (e) { threw = true; msg = String((e && e.message) || e); }

if (threw) {
  process.stdout.write('ANVIL_REPRODUCED threw=' + JSON.stringify(msg) + '\\n');
  process.exit(0);
} else {
  process.stdout.write('ANVIL_NOT_REPRODUCED\\n');
  process.exit(2);
}
`;
  const filePath = resolve(tmpdir(), `anvil-throws-${safeStamp()}.cjs`);
  return {
    language: lang,
    filePath,
    source,
    runCommand: { cmd: 'node', args: [filePath] },
  };
}

function buildPyThrowsTest(functionName: string): MicroTest {
  const source = `# Anvil R3 micro-test — throws probe
import sys

def ${functionName}():
    # __ANVIL_FN_BODY__
    return 0

threw = False
msg = ""
try:
    ${functionName}()
except Exception as e:
    threw = True
    msg = str(e)

if threw:
    sys.stdout.write(f"ANVIL_REPRODUCED threw={msg!r}\\n")
    sys.exit(0)
else:
    sys.stdout.write("ANVIL_NOT_REPRODUCED\\n")
    sys.exit(2)
`;
  const filePath = resolve(tmpdir(), `anvil-throws-${safeStamp()}.py`);
  return {
    language: 'py',
    filePath,
    source,
    runCommand: { cmd: 'python3', args: [filePath] },
  };
}

function buildGoThrowsTest(functionName: string): MicroTest {
  const source = `// Anvil R3 micro-test — throws probe
package main

import (
\t"fmt"
\t"os"
)

func ${functionName}() {
\t// __ANVIL_FN_BODY__
}

func main() {
\tdefer func() {
\t\tif r := recover(); r != nil {
\t\t\tfmt.Printf("ANVIL_REPRODUCED panic=%v\\n", r)
\t\t\tos.Exit(0)
\t\t}
\t\tfmt.Println("ANVIL_NOT_REPRODUCED")
\t\tos.Exit(2)
\t}()
\t${functionName}()
}
`;
  const filePath = resolve(tmpdir(), `anvil-throws-${safeStamp()}.go`);
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
