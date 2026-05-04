import { loadConventions as coreLoadConventions } from '@anvil/convention-core';
import { getAnvilDirs } from '../home.js';

export async function loadConventions(project: string): Promise<string> {
  const dirs = getAnvilDirs();
  return coreLoadConventions(
    { conventionsDir: dirs.conventions, rulesDir: dirs.conventionRules },
    project,
  );
}
