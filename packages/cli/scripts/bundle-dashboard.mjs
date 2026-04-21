#!/usr/bin/env node
import { cpSync, existsSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(here, '..');
const dashboardRoot = resolve(cliRoot, '..', 'dashboard');
const outRoot = resolve(cliRoot, 'dist', 'dashboard');

const dashboardDist = resolve(dashboardRoot, 'dist');
const dashboardServer = resolve(dashboardRoot, 'server');

if (!existsSync(resolve(dashboardDist, 'index.html'))) {
  console.error('[bundle-dashboard] dashboard/dist/index.html missing — did vite build run?');
  process.exit(1);
}
if (!existsSync(resolve(dashboardServer, 'dashboard-server.js'))) {
  console.error('[bundle-dashboard] dashboard/server/dashboard-server.js missing — did the server build run?');
  process.exit(1);
}

rmSync(outRoot, { recursive: true, force: true });
mkdirSync(outRoot, { recursive: true });

cpSync(dashboardDist, resolve(outRoot, 'dist'), { recursive: true });

cpSync(dashboardServer, resolve(outRoot, 'server'), {
  recursive: true,
  filter: (src) => {
    if (src.includes('/__tests__')) return false;
    if (src.includes('/out/')) return false;
    if (src.endsWith('.ts') && !src.endsWith('.d.ts')) return false;
    return true;
  },
});

console.log('[bundle-dashboard] bundled dashboard into dist/dashboard/');
