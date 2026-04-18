import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface KnowledgeConfig {
  embedding: {
    provider: 'codestral' | 'voyage' | 'openai' | 'nomic-local' | 'ollama' | 'gemini' | 'gemini-oauth' | 'auto';
    model?: string;
    dimensions?: number;
    apiKeyEnv?: string;
  };
  chunking: {
    maxTokens: number;
    contextEnrichment: 'structural' | 'llm' | 'none';
  };
  retrieval: {
    maxChunks: number;
    maxTokens: number;
    hybridWeights: { vector: number; bm25: number; graph: number };
    reranker: 'cohere' | 'voyage' | 'ollama' | 'none';
  };
  autoIndex: boolean;
}

export const DEFAULT_CONFIG: KnowledgeConfig = {
  embedding: { provider: 'auto', dimensions: 1024 },
  chunking: { maxTokens: 500, contextEnrichment: 'structural' },
  retrieval: {
    maxChunks: 20,
    maxTokens: 12000,
    hybridWeights: { vector: 0.5, bm25: 0.3, graph: 0.2 },
    reranker: 'ollama',
  },
  autoIndex: true,
};

/** Load knowledge config from factory.yaml, merging with defaults */
export function loadKnowledgeConfig(project: string): KnowledgeConfig {
  const anvilHome = process.env.ANVIL_HOME || join(homedir(), '.anvil');
  const paths = [
    join(anvilHome, 'projects', project, 'factory.yaml'),
    join(anvilHome, 'projects', project, 'project.yaml'),
  ];

  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const raw = readFileSync(p, 'utf-8');
      return parseKnowledgeSection(raw);
    } catch { /* use defaults */ }
  }
  return { ...DEFAULT_CONFIG };
}

function parseKnowledgeSection(yaml: string): KnowledgeConfig {
  // Minimal YAML parsing for knowledge section
  const config = { ...DEFAULT_CONFIG };

  // Parse embedding provider
  const providerMatch = yaml.match(/^\s{4}provider:\s+(\S+)/m);
  if (providerMatch) {
    config.embedding = { ...config.embedding, provider: providerMatch[1] as any };
  }

  // Parse embedding model
  const modelMatch = yaml.match(/^\s{4}model:\s+(\S+)/m);
  if (modelMatch) config.embedding.model = modelMatch[1];

  // Parse dimensions
  const dimMatch = yaml.match(/^\s{4}dimensions:\s+(\d+)/m);
  if (dimMatch) config.embedding.dimensions = parseInt(dimMatch[1], 10);

  // Parse chunking max_tokens
  const chunkMatch = yaml.match(/^\s{4}max_tokens:\s+(\d+)/m);
  if (chunkMatch) config.chunking.maxTokens = parseInt(chunkMatch[1], 10);

  // Parse context_enrichment
  const enrichMatch = yaml.match(/^\s{4}context_enrichment:\s+(\S+)/m);
  if (enrichMatch) config.chunking.contextEnrichment = enrichMatch[1] as any;

  // Parse auto_index
  const autoMatch = yaml.match(/^\s{2}auto_index:\s+(true|false)/m);
  if (autoMatch) config.autoIndex = autoMatch[1] === 'true';

  return config;
}

/** Get the knowledge base storage path for a project */
export function getKnowledgeBasePath(project: string): string {
  // CODE_SEARCH_DATA_DIR takes priority (Docker / production)
  const dataDir = process.env.CODE_SEARCH_DATA_DIR;
  if (dataDir) return join(dataDir, project);

  const anvilHome = process.env.ANVIL_HOME || join(homedir(), '.anvil');
  return join(anvilHome, 'knowledge-base', project);
}
