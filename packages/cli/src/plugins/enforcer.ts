import type { PersonaName } from '../personas/types.js';
import { DEFAULT_PLUGIN_MAPPING } from './catalog.js';
import type { PluginAvailability } from './availability.js';

export function getPersonaPluginList(persona: PersonaName): string[] {
  return DEFAULT_PLUGIN_MAPPING[persona] || [];
}

export function isPluginAllowed(persona: PersonaName, plugin: string): boolean {
  const allowed = getPersonaPluginList(persona);
  return allowed.includes(plugin);
}

export function buildMcpServerFlags(
  persona: PersonaName,
  available: PluginAvailability[],
): string[] {
  const allowed = getPersonaPluginList(persona);
  const availableSet = new Set(
    available.filter(p => p.status === 'available').map(p => p.name),
  );

  const active = allowed.filter(p => availableSet.has(p));
  return active.map(p => `--mcp-server=${p}`);
}
