#!/usr/bin/env node
/**
 * Build script — compiles TS to JS with esbuild, fixes ESM .js extensions.
 */
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';

// 1. Find all .ts files under src/
function findTs(dir, out = []) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) findTs(p, out);
    else if (e.endsWith('.ts')) out.push(p);
  }
  return out;
}

const files = findTs('src');
console.log(`Compiling ${files.length} files...`);

// 2. Compile each with esbuild
for (const f of files) {
  const out = f.replace(/^src\//, 'dist/').replace(/\.ts$/, '.js');
  mkdirSync(dirname(out), { recursive: true });
  execSync(`npx esbuild "${f}" --outfile="${out}" --format=esm --platform=node --target=node20`, { stdio: 'pipe' });
}

// 3. Fix .js extensions on relative imports
function fixExtensions(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) { fixExtensions(p); continue; }
    if (!e.endsWith('.js')) continue;
    let content = readFileSync(p, 'utf-8');
    let fixed = content.replace(/from "(\.\.?\/[^"]+)"/g, (m, path) => {
      if (path.endsWith('.js') || path.startsWith('@') || path.startsWith('node:')) return m;
      return `from "${path}.js"`;
    });
    fixed = fixed.replace(/import\("(\.\.?\/[^"]+)"\)/g, (m, path) => {
      if (path.endsWith('.js')) return m;
      return `import("${path}.js")`;
    });
    if (fixed !== content) writeFileSync(p, fixed);
  }
}

fixExtensions('dist');
console.log(`Done. ${files.length} files in dist/`);
