/**
 * Registry of every tool in the browser/web surface, plus the per-stage
 * web-permission table. Mirrors `routing/stage-permissions.ts` but for
 * the network/browser tool classes (network / browse-headless /
 * browse-eval / browse-pixel) layered on top of read/write/exec.
 */

import type { WebToolClass } from './web-types.js';
import { WEB_TOOLS_BY_CLASS } from './web-types.js';

/**
 * Default per-stage web-tool permission set. Keep `build` and `ship`
 * empty — those stages mutate the workspace; granting them live network
 * access amplifies the blast radius of a prompt-injection attack.
 *
 * Validate gets the most: it's the canonical "is the change correct?"
 * stage and needs eyes on the dev server.
 */
export const STAGE_WEB_PERMISSIONS: Readonly<Record<string, readonly WebToolClass[]>> = {
  // Pipeline stages
  clarify:                ['network'],
  requirements:           ['network'],
  'repo-requirements':    ['network'],
  specs:                  ['network'],
  tasks:                  ['network'],
  plan:                   ['network'],
  build:                  [],
  test:                   ['network', 'browse-headless'],
  validate:               ['network', 'browse-headless', 'browse-eval', 'browse-pixel'],
  ship:                   [],

  // Ad-hoc commands
  fix:                    [],
  'fix-loop':             [],
  review:                 ['network'],
  research:               ['network'],
  reflection:             [],
};

/** Resolve the list of web/browser tool names allowed for a given stage. */
export function allowedWebToolsForStage(stage: string): string[] {
  const classes = STAGE_WEB_PERMISSIONS[stage] ?? [];
  const tools = new Set<string>();
  for (const cls of classes) {
    for (const t of WEB_TOOLS_BY_CLASS[cls]) tools.add(t);
  }
  return [...tools].sort();
}

/** Resolve the web permission classes for a given stage. */
export function webPermissionClassesForStage(stage: string): WebToolClass[] {
  return [...(STAGE_WEB_PERMISSIONS[stage] ?? [])];
}

/** Test if a stage may invoke a specific web/browser tool. */
export function stageMayInvokeWebTool(stage: string, toolName: string): boolean {
  return allowedWebToolsForStage(stage).includes(toolName);
}
