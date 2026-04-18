// Code chunk — atomic unit of knowledge
export interface CodeChunk {
  id: string;                    // deterministic: sha256(filePath + startLine + endLine)
  filePath: string;              // relative to repo root
  repoName: string;
  project: string;
  startLine: number;
  endLine: number;
  content: string;               // raw source code
  contextPrefix: string;         // structural context (file path, scope chain, imports)
  contextualizedContent: string; // contextPrefix + '\n' + content (what gets embedded)
  language: string;
  entityType: 'function' | 'class' | 'method' | 'interface' | 'type' | 'module' | 'import' | 'block';
  entityName?: string;           // function/class/method name
  parentEntity?: string;         // containing class/module
  tokens: number;                // estimated token count (chars/4)
  imports: string[];             // imported symbols
  exports: string[];             // exported symbols
  embedding?: number[];          // vector (populated during indexing)
}

// Cross-repo relationship detected from code analysis
export interface CrossRepoEdge {
  sourceRepo: string;
  sourceNode: string;            // file::entity or entity name
  targetRepo: string;
  targetNode: string;
  edgeType: 'shared-type' | 'shared-dep' | 'api-contract' | 'event-schema' |
            'kafka' | 'http' | 'grpc' | 'database' | 'env-var' | 'npm-dep' |
            'workspace-dep' | 'workspace-import' | 'llm-inferred' |
            'redis' | 's3' | 'proto' | 'docker-compose' | 'k8s-service' | 'shared-constant';
  evidence: string;              // what was matched
  confidence: number;            // 0-1
}

// ---------------------------------------------------------------------------
// Workspace detection — universal monorepo package discovery
// ---------------------------------------------------------------------------

/** One discovered package within a workspace */
export interface WorkspacePackage {
  name: string;           // package name from manifest (e.g., '@popup-forms/ui-kit')
  path: string;           // absolute path to package root
  relativePath: string;   // relative to repo root (e.g., 'packages/ui-kit')
  ecosystem: string;      // detected ecosystem identifier
  manifestFile: string;   // which file was parsed (e.g., 'package.json')
  dependencies: string[]; // declared dependency package names
}

/** Full workspace map for a single repo */
export interface WorkspaceMap {
  repoPath: string;
  packages: WorkspacePackage[];
  nameToPackage: Map<string, WorkspacePackage>;
  pathAliases: Map<string, string>;  // tsconfig/alias → resolved relative path
}

// Scored retrieval result
export interface ScoredChunk {
  chunk: CodeChunk;
  score: number;
  source: 'vector' | 'bm25' | 'graph' | 'fused';
}

// Full retrieval result
export interface RetrievalResult {
  chunks: ScoredChunk[];
  graphContext: string;           // graph-based context (related modules, dependencies)
  totalTokens: number;
  query: string;
}

// Index statistics
export interface IndexStats {
  project: string;
  repos: Array<{ name: string; chunkCount: number; language: string }>;
  totalChunks: number;
  totalTokens: number;
  embeddingProvider: string;
  embeddingDimensions: number;
  crossRepoEdges: number;
  lastIndexed: string;
  indexDurationMs: number;
}

// Embedding provider interface
export interface EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<number[][]>;
  embedSingle(text: string): Promise<number[]>;
}

// Graphify per-repo output (graph.json format)
export interface GraphifyNode {
  id: string;
  label?: string;
  community?: number;
  type?: string;
  file?: string;
}

export interface GraphifyEdge {
  source: string;
  target: string;
  type?: string;
  confidence?: number;  // 0.0-1.0: edge reliability for weighted BFS
}

export interface GraphifyOutput {
  nodes: GraphifyNode[];
  links: GraphifyEdge[];
}

// Project graph node (namespaced)
export interface ProjectGraphNode {
  id: string;        // "repoName::originalId"
  repo: string;
  label: string;
  community?: number;
  type?: string;
  file?: string;
  centrality?: number;
}

// ---------------------------------------------------------------------------
// LLM-powered project graph (semantic project understanding)
// ---------------------------------------------------------------------------

export interface ProjectGraphMeta {
  generatedAt: string;
  model: string;
  provider: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: number;
}

export interface RepoRole {
  role: string;
  responsibilities: string[];
  ownsData: string[];
  criticality: 'high' | 'medium' | 'low';
}

export interface ProjectRelationship {
  from: string;
  to: string;
  type: 'sync-http' | 'async-event' | 'shared-db' | 'shared-types' | 'deploys-to' | 'other';
  description: string;
  contract: string;
  criticality: 'high' | 'medium' | 'low';
  direction: 'unidirectional' | 'bidirectional';
}

export interface FlowStep {
  repo: string;
  component: string;
  action: string;
  protocol: string;
  nextStep?: string;
}

export interface KeyFlow {
  name: string;
  trigger: string;
  steps: FlowStep[];
  failureMode: string;
}

export interface CommunityLabel {
  label: string;
  description: string;
  repos: string[];
}

export interface ProjectGraph {
  meta: ProjectGraphMeta;
  architectureSummary: string;
  repoRoles: Record<string, RepoRole>;
  communityLabels: Record<string, CommunityLabel>;
  relationships: ProjectRelationship[];
  keyFlows: KeyFlow[];
}

export interface ProjectGraphStatus {
  exists: boolean;
  generatedAt: string | null;
  model: string | null;
  costUsd: number | null;
}

// ---------------------------------------------------------------------------
// Repo Profiling — autonomous repo understanding (WS-1)
// ---------------------------------------------------------------------------

/** Structured profile of a repository, generated by LLM analysis */
export interface RepoProfile {
  name: string;
  role: 'service' | 'library' | 'cli' | 'worker' | 'gateway' | 'ui' | 'schema' | 'config' | 'monorepo' | 'unknown';
  domain: string;                    // inferred domain/team (e.g., "email-delivery", "billing", "auth")
  description: string;               // 1-2 sentence description of what this repo does
  technologies: string[];            // detected tech stack (languages, frameworks, DBs)
  exposes: ServiceEndpoint[];        // what this repo provides to others
  consumes: ServiceEndpoint[];       // what this repo depends on from others
  entryPoints: string[];             // main entry files (e.g., "cmd/server/main.go")
  profiledAt: string;                // ISO timestamp
  profiledBy: string;                // model used
  fingerprintHash: string;           // hash of fingerprint files — skip re-profiling if unchanged
}

/** A service endpoint (HTTP, Kafka, gRPC, DB, etc.) */
export interface ServiceEndpoint {
  type: 'http' | 'grpc' | 'kafka-producer' | 'kafka-consumer' | 'database' | 'redis' | 's3' | 'websocket' | 'cron' | 'other';
  identifier: string;                // topic name, HTTP path, DB table, etc.
  description: string;
}
