// Section I — Hook Installer
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HookConfig } from './types.js';
import { generateHookConfig } from './generator.js';
import type { GeneratorOptions } from './generator.js';

export interface FsAdapter {
  readFileSync(path: string, encoding: BufferEncoding): string;
  writeFileSync(path: string, data: string): void;
  mkdirSync(path: string, options: { recursive: boolean }): void;
  existsSync(path: string): boolean;
}

const defaultFs: FsAdapter = {
  readFileSync,
  writeFileSync,
  mkdirSync: (p, o) => { mkdirSync(p, o); },
  existsSync,
};

const HOOKS_FILE = '.claude/hooks.json';

/**
 * Install hooks by writing/merging into .claude/hooks.json.
 */
export function installHooks(
  projectRoot: string,
  options: GeneratorOptions = {},
  fs: FsAdapter = defaultFs,
): HookConfig {
  const config = generateHookConfig(options);
  const hooksPath = join(projectRoot, HOOKS_FILE);
  const dir = dirname(hooksPath);

  fs.mkdirSync(dir, { recursive: true });

  let existing: HookConfig = { hooks: [], version: '1.0' };
  if (fs.existsSync(hooksPath)) {
    try {
      existing = JSON.parse(fs.readFileSync(hooksPath, 'utf-8')) as HookConfig;
    } catch {
      // If corrupt, overwrite
    }
  }

  // Merge: remove old ff-hook entries, add new ones
  const filteredHooks = existing.hooks.filter(
    (h) => !h.name.startsWith('ff-hook-'),
  );
  const merged: HookConfig = {
    hooks: [...filteredHooks, ...config.hooks],
    version: config.version,
  };

  fs.writeFileSync(hooksPath, JSON.stringify(merged, null, 2));
  return merged;
}

/**
 * Remove ff-hook entries from .claude/hooks.json.
 */
export function removeHooks(
  projectRoot: string,
  fs: FsAdapter = defaultFs,
): void {
  const hooksPath = join(projectRoot, HOOKS_FILE);

  if (!fs.existsSync(hooksPath)) return;

  try {
    const existing = JSON.parse(fs.readFileSync(hooksPath, 'utf-8')) as HookConfig;
    const filtered: HookConfig = {
      hooks: existing.hooks.filter((h) => !h.name.startsWith('ff-hook-')),
      version: existing.version,
    };
    fs.writeFileSync(hooksPath, JSON.stringify(filtered, null, 2));
  } catch {
    // Non-fatal
  }
}
