// Project-level enums
export const VALID_SYSTEM_LIFECYCLES = ['production', 'experimental', 'deprecated', 'development', 'staging', 'retired'] as const;
export type SystemLifecycle = typeof VALID_SYSTEM_LIFECYCLES[number];

export const VALID_SYSTEM_TYPES = ['backend', 'fullstack-mfe'] as const;
export type ProjectType = typeof VALID_SYSTEM_TYPES[number];

export const VALID_TIERS = ['critical', 'high', 'standard', 'low'] as const;
export type Tier = typeof VALID_TIERS[number];

// Repo-level enums
export const VALID_REPO_TYPES = ['service', 'mfe-child', 'mfe-container', 'mfe-shared', 'umbrella', 'frontend', 'worker', 'library', 'cli'] as const;
export type RepoType = typeof VALID_REPO_TYPES[number];

export const VALID_REPO_KINDS = ['service', 'multi-component-service', 'library', 'tooling', 'infra', 'docs'] as const;
export type RepoKind = typeof VALID_REPO_KINDS[number];

export const VALID_RUNTIME_KINDS = ['http-service', 'grpc-service', 'kafka-consumer', 'kafka-producer', 'worker', 'retry-worker', 'scheduler', 'batch-job', 'cli', 'library', 'local-benchmark'] as const;
export type RuntimeKind = typeof VALID_RUNTIME_KINDS[number];

// Severity/Criticality
export const VALID_SHARP_EDGE_SEVERITIES = ['high', 'medium', 'low'] as const;
export type SharpEdgeSeverity = typeof VALID_SHARP_EDGE_SEVERITIES[number];

export const VALID_INVARIANT_CRITICALITIES = ['high', 'medium', 'low'] as const;
export type InvariantCriticality = typeof VALID_INVARIANT_CRITICALITIES[number];

export const CURRENT_SCHEMA_VERSION = 2;
