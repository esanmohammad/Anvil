#!/usr/bin/env node
/**
 * Publish only the workspace packages whose `version` in `package.json`
 * is newer than what's currently on the npm registry. The cli is
 * deliberately last so its release tag never lands referencing
 * unpublished sub-packages.
 *
 * Run from repo root in CI:
 *   node scripts/publish-changed.mjs
 *
 * Env:
 *   NPM_TOKEN     — required, used by `~/.npmrc` set up by setup-node.
 *   DRY_RUN=1     — log what would publish without actually publishing.
 *
 * Provenance: when invoked from a GitHub Actions workflow with
 * `id-token: write`, npm will attach a sigstore attestation linking the
 * tarball to the source commit. The attestation surfaces on npmjs.com
 * (the "Provenance" tab) and on the repo's "Security → Attestations"
 * page.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

// Topological order: every package's dependencies must publish before it.
// cli is last because every other public package is one of its deps.
const ORDER = [
  'packages/agent-core',
  'packages/knowledge-core',
  'packages/memory-core',
  'packages/convention-core',
  'packages/core-pipeline',
  'packages/code-search-mcp',
  'packages/cli',
];

const DRY_RUN = process.env.DRY_RUN === '1';

function readPkg(dir) {
  return JSON.parse(readFileSync(join(ROOT, dir, 'package.json'), 'utf-8'));
}

function exec(cmd, opts = {}) {
  return execSync(cmd, { stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf-8', ...opts }).trim();
}

function isAlreadyPublished(name, version) {
  try {
    // `npm view name@version version` — prints version if it exists, exits 0; empty if not on registry
    const out = exec(`npm view ${name}@${version} version`, { stdio: ['ignore', 'pipe', 'ignore'] });
    return out === version;
  } catch {
    // Non-zero exit => version not on registry
    return false;
  }
}

function publish(dir, name, version) {
  if (DRY_RUN) {
    console.log(`[dry-run] would publish ${name}@${version} from ${dir}`);
    return;
  }
  // --provenance lights up only when GitHub Actions OIDC is available.
  // The flag is harmless locally — npm just falls back to a normal publish.
  exec(`npm publish --access public --provenance`, {
    cwd: join(ROOT, dir),
    stdio: 'inherit',
  });
}

let published = 0;
let skipped = 0;
const failures = [];

for (const dir of ORDER) {
  const pkg = readPkg(dir);
  if (pkg.private) {
    console.log(`-- skip ${pkg.name} (private)`);
    continue;
  }
  if (isAlreadyPublished(pkg.name, pkg.version)) {
    console.log(`-- skip ${pkg.name}@${pkg.version} (already on registry)`);
    skipped++;
    continue;
  }
  console.log(`++ publish ${pkg.name}@${pkg.version}`);
  try {
    publish(dir, pkg.name, pkg.version);
    published++;
  } catch (err) {
    console.error(`!! failed to publish ${pkg.name}@${pkg.version}:`, err.message ?? err);
    failures.push(pkg.name);
  }
}

console.log(`\nDone — published ${published}, skipped ${skipped}, failed ${failures.length}`);
if (failures.length > 0) {
  console.error('Failed:', failures.join(', '));
  process.exit(1);
}
