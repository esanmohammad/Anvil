// Known infrastructure types that can be deployed locally
export const KNOWN_TYPES = [
  'bigtable-emulator',
  'clickhouse',
  'elasticsearch',
  'kafka',
  'mongo',
  'postgres',
  'redis',
  'redis-cluster',
  'rmq',
  's3',
  'scylla',
  'wiremock',
] as const;

export type KnownInfraType = typeof KNOWN_TYPES[number];

// Fast lookup set
const knownSet = new Set<string>(KNOWN_TYPES);

// Aliases for common alternative names
export const TYPE_ALIASES: Record<string, string> = {
  mongodb: 'mongo',
  postgresql: 'postgres',
  rabbitmq: 'rmq',
};

// Cloud-only types (not deployable locally, but valid in project.yaml)
export const CLOUD_ONLY_TYPES = ['gcp-production'] as const;
const cloudOnlySet = new Set<string>(CLOUD_ONLY_TYPES);

// Normalize: lowercase, trim, resolve aliases
export function normalizeType(raw: string): string {
  const trimmed = raw.toLowerCase().trim();
  return TYPE_ALIASES[trimmed] || trimmed;
}

// Check if a type is supported for local deployment
export function isSupported(raw: string): boolean {
  return knownSet.has(normalizeType(raw));
}

// Check if a type is cloud-only
export function isCloudOnly(raw: string): boolean {
  return cloudOnlySet.has(normalizeType(raw));
}
