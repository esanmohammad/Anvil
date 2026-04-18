import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';

export function getAnvilHome(): string {
  if (process.env.ANVIL_HOME) return process.env.ANVIL_HOME;
  if (process.env.FF_HOME) return process.env.FF_HOME;
  // Prefer ~/.anvil, but fall back to ~/.feature-factory if it exists (backward compat)
  const newHome = join(homedir(), '.anvil');
  const legacyHome = join(homedir(), '.feature-factory');
  if (existsSync(newHome)) return newHome;
  if (existsSync(legacyHome)) return legacyHome;
  return newHome; // default for fresh installs
}

/** @deprecated Use getAnvilHome() */
export const getFFHome = getAnvilHome;

export const ANVIL_HOME = getAnvilHome();
/** @deprecated Use ANVIL_HOME */
export const FF_HOME = ANVIL_HOME;

export interface AnvilHome {
  config: string;
  projects: string;
  personas: string;
  conventions: string;
  conventionRules: string;
  memory: string;
  memoryGlobal: string;
  runs: string;
  workspaces: string;
  logs: string;
}

/** @deprecated Use AnvilHome */
export type FFHome = AnvilHome;

export function getAnvilDirs(home?: string): AnvilHome {
  const base = home || getAnvilHome();
  return {
    config: base,
    projects: join(base, 'projects'),
    personas: join(base, 'personas'),
    conventions: join(base, 'conventions'),
    conventionRules: join(base, 'conventions', 'rules'),
    memory: join(base, 'memory'),
    memoryGlobal: join(base, 'memory', 'global'),
    runs: join(base, 'runs'),
    workspaces: join(base, 'workspaces'),
    logs: join(base, 'logs'),
  };
}

/** @deprecated Use getAnvilDirs() */
export const getFFDirs = getAnvilDirs;

export const ANVIL_DIRS = getAnvilDirs();
/** @deprecated Use ANVIL_DIRS */
export const FF_DIRS = ANVIL_DIRS;
