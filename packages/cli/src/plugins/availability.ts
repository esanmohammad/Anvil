export type PluginStatus = 'available' | 'unavailable' | 'unknown';

export interface PluginAvailability {
  name: string;
  status: PluginStatus;
}

const cache = new Map<string, { status: PluginStatus; timestamp: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export async function checkPluginAvailability(plugins: string[]): Promise<PluginAvailability[]> {
  const results: PluginAvailability[] = [];

  for (const name of plugins) {
    const cached = cache.get(name);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      results.push({ name, status: cached.status });
      continue;
    }

    // For now, mark all as available (actual MCP health check will be implemented when MCP integration is ready)
    const status: PluginStatus = 'available';
    cache.set(name, { status, timestamp: Date.now() });
    results.push({ name, status });
  }

  return results;
}

export function clearAvailabilityCache(): void {
  cache.clear();
}
