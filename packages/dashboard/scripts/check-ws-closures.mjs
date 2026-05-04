#!/usr/bin/env node
/**
 * check-ws-closures — grep-based scanner for the stale-closure bug we fixed
 * in ReviewPage: a WebSocket `message` useEffect with `[ws]` deps that reads
 * a state variable inside the handler, relying on closure rather than
 * functional setState.
 *
 * This is a placeholder for the ESLint rule described in the test-gen plan
 * §13 (`no-stale-ws-closure`). Once ESLint infra lands in the monorepo,
 * promote this to a proper rule.
 *
 * Exit codes:
 *   0  — clean
 *   1  — at least one suspicious file
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const SRC = join(__dirname, '..', 'src');

const WS_LISTENER = /ws\.addEventListener\(\s*['"]message['"]/;
const WS_DEPS_ONLY = /}\s*,\s*\[\s*ws\s*\]\s*\)/;
// Matches setX(nonFunctional) — negative: we want to flag these inside handlers.
// "functional" means the first non-space char inside the setter call is `(` or
// starts a function expression (`function(`, `async (`, etc.).
const NON_FUNCTIONAL_SETTER = /\bset[A-Z]\w*\((?!\s*(?:\(|function|async\b))/;

const offenders = [];

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const s = statSync(full);
    if (s.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.next') continue;
      walk(full);
    } else if (entry.endsWith('.tsx') || entry.endsWith('.ts')) {
      scan(full);
    }
  }
}

function scan(file) {
  const src = readFileSync(file, 'utf-8');
  if (!WS_LISTENER.test(src)) return;

  // Find each useEffect block containing the WS listener.
  const effectBlocks = extractUseEffectBlocks(src);
  for (const { body, depArray, startLine } of effectBlocks) {
    if (!WS_LISTENER.test(body)) continue;
    if (!WS_DEPS_ONLY.test(depArray)) continue;

    const suspicious = [];
    const lines = body.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      if (trimmed.startsWith('//')) continue;
      // Skip `setResource((prev) => …)` — that's the safe form we want.
      const m = line.match(NON_FUNCTIONAL_SETTER);
      if (m) suspicious.push({ lineNo: startLine + i, text: trimmed.slice(0, 140) });
    }
    if (suspicious.length) {
      offenders.push({ file: relative(process.cwd(), file), items: suspicious });
    }
  }
}

function extractUseEffectBlocks(src) {
  // Very coarse — finds `useEffect(() => { ... }, [deps])` blocks using brace
  // counting. Good enough for heuristic scanning.
  const blocks = [];
  const rx = /useEffect\(\s*\(\)\s*=>\s*\{/g;
  let m;
  while ((m = rx.exec(src)) !== null) {
    const openIdx = src.indexOf('{', m.index);
    if (openIdx === -1) continue;
    let depth = 1;
    let i = openIdx + 1;
    while (i < src.length && depth > 0) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') depth--;
      i++;
    }
    if (depth !== 0) continue;
    const bodyStart = openIdx + 1;
    const bodyEnd = i - 1;
    const body = src.slice(bodyStart, bodyEnd);
    // Extract dep array that follows `},`
    const tail = src.slice(i, src.indexOf(')', i) + 1);
    const startLine = src.slice(0, bodyStart).split('\n').length;
    blocks.push({ body, depArray: tail, startLine });
  }
  return blocks;
}

walk(SRC);

if (offenders.length === 0) {
  console.log('[check-ws-closures] clean — no stale-closure patterns found');
  process.exit(0);
}

console.error('[check-ws-closures] suspicious patterns — WS message handler with [ws] deps + non-functional setState:');
for (const o of offenders) {
  console.error(`\n  ${o.file}`);
  for (const it of o.items) {
    console.error(`    L${it.lineNo}: ${it.text}`);
  }
}
console.error('\nRefactor each `setX(value)` to `setX((prev) => …)` or add the read state to the deps array.');
console.error('See packages/dashboard/src/components/common/useResolvableFinding.ts for the pattern.');
process.exit(1);
