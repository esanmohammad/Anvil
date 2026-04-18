import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { getFFHome } from '../home.js';
import { DEFAULT_PLUGIN_MAPPING } from './catalog.js';
import type { PluginMapping } from './types.js';

export interface PluginConfig {
  personas: PluginMapping;
}

export function getDefaultConfig(): PluginConfig {
  return { personas: { ...DEFAULT_PLUGIN_MAPPING } };
}

export async function loadPluginConfig(): Promise<PluginConfig> {
  const configPath = join(getFFHome(), 'plugins', 'engineering.yaml');
  const defaults = getDefaultConfig();

  if (!existsSync(configPath)) return defaults;

  try {
    const raw = await readFile(configPath, 'utf-8');
    const parsed = YAML.parse(raw) as Partial<PluginConfig>;

    if (parsed?.personas) {
      // Deep merge: user overrides extend defaults
      for (const [persona, plugins] of Object.entries(parsed.personas)) {
        defaults.personas[persona] = plugins;
      }
    }

    return defaults;
  } catch {
    return defaults;
  }
}
