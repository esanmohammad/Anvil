#!/usr/bin/env node
/**
 * Copy compiled output from `server/out/` into `server/` so the
 * dashboard package can be imported as plain ESM JS (matching the
 * `main` + `exports` fields in package.json).
 *
 * Why we do this: the package's main file is `server/dashboard-server.js`,
 * not `server/out/dashboard-server.js`. The CLI's `bundle-dashboard.mjs`
 * also reads from `server/` (not `server/out/`) to skip the `.ts`
 * sources. This script promotes every `.js` + `.d.ts` from
 * `out/*` (recursively, minus tests) into its mirror location under
 * `server/`.
 *
 * Replaces the old chain of `cp server/out/<dir>/*.js …` commands in
 * `package.json` that had to be edited every time a new directory
 * was added under `server/`.
 */
import { cpSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const dashboardRoot = resolve(here, '..');
const outRoot = join(dashboardRoot, 'server', 'out');
const targetRoot = join(dashboardRoot, 'server');

if (!existsSync(outRoot)) {
  console.error('[copy-out] server/out/ missing — did tsc -p server/tsconfig.json run?');
  process.exit(1);
}

const SKIP_DIRS = new Set(['__tests__']);

/**
 * Filter for cpSync: only copy `.js`, `.js.map`, `.d.ts`, `.d.ts.map`.
 * Skips test directories. Source paths are absolute; we test
 * extension + path-segment membership.
 */
const filter = (src) => {
  for (const skip of SKIP_DIRS) {
    if (src.includes(`/${skip}/`) || src.endsWith(`/${skip}`)) return false;
  }
  if (existsSync(src) && statSync(src).isDirectory()) return true;
  return /\.(js|d\.ts)(\.map)?$/.test(src);
};

let copied = 0;
for (const entry of readdirSync(outRoot)) {
  if (SKIP_DIRS.has(entry)) continue;
  const src = join(outRoot, entry);
  const dest = join(targetRoot, entry);
  const isDir = statSync(src).isDirectory();
  if (isDir) {
    // Merge into destination dir. We deliberately do NOT wipe — some
    // subdirs (plan-validator-rules/, review-checks/) carry committed
    // .ts sources alongside the .js outputs.
    cpSync(src, dest, { recursive: true, filter });
  } else {
    if (filter(src)) cpSync(src, dest);
  }
  copied++;
}

console.log(`[copy-out] promoted ${copied} entry(ies) from server/out/ → server/`);
