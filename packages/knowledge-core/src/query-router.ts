import type { EmbeddingProvider, RepoProfile } from '@esankhan3/anvil-knowledge-core';
import type { KnowledgeConfig } from './config.js';
import { loadAllProfiles } from './repo-profiler.js';
import { resolveStorage } from './storage/resolve.js';
import type { BlobStorePort } from './storage/ports.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProfileEmbedding {
  repoName: string;
  embedding: number[];
  textUsed: string; // the text that was embedded (for debugging)
}

export interface RouteResult {
  repos: string[];              // ordered by relevance (most relevant first)
  scores: Map<string, number>;  // repo -> similarity score
  strategy: 'all' | 'filtered'; // did we filter or return all?
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a searchable text representation of a repo profile.
 * Combines name, role, domain, description, technologies, and endpoint info.
 */
function profileToSearchText(profile: RepoProfile): string {
  const parts = [
    `Repository: ${profile.name}`,
    `Role: ${profile.role}`,
    `Domain: ${profile.domain}`,
    `Description: ${profile.description}`,
    `Technologies: ${profile.technologies.join(', ')}`,
  ];

  if (profile.exposes.length > 0) {
    parts.push(
      `Exposes: ${profile.exposes.map((e) => `${e.type}:${e.identifier}`).join(', ')}`,
    );
  }
  if (profile.consumes.length > 0) {
    parts.push(
      `Consumes: ${profile.consumes.map((c) => `${c.type}:${c.identifier}`).join(', ')}`,
    );
  }

  return parts.join('\n');
}

/**
 * Compute cosine similarity between two vectors of equal length.
 * Returns a value in [-1, 1]; higher means more similar.
 */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB) + 1e-10);
}

// ---------------------------------------------------------------------------
// Profile Embedding
// ---------------------------------------------------------------------------

/**
 * Embed all repo profiles and return the embeddings.
 * Batches all profiles into a single embedding call for efficiency.
 */
export async function embedProfiles(
  profiles: RepoProfile[],
  embedder: EmbeddingProvider,
): Promise<ProfileEmbedding[]> {
  if (profiles.length === 0) return [];

  const texts = profiles.map(profileToSearchText);
  const embeddings = await embedder.embed(texts);

  return profiles.map((profile, i) => ({
    repoName: profile.name,
    embedding: embeddings[i],
    textUsed: texts[i],
  }));
}

// ---------------------------------------------------------------------------
// Query Routing
// ---------------------------------------------------------------------------

/**
 * Route a query to the most relevant repos by comparing query embedding
 * against cached profile embeddings.
 *
 * Strategy:
 * - If <=10 repos total, return all (no filtering needed)
 * - Embed the query
 * - Compute cosine similarity against each profile embedding
 * - Return repos above a dynamic threshold (mean + 0.5 * stddev)
 * - Always return at least `minRepos` (default 3) and at most `maxFraction`
 *   (default 60%) of total
 * - If no repos score above threshold, return top 5 by score
 */
export async function routeQuery(
  query: string,
  profileEmbeddings: ProfileEmbedding[],
  embedder: EmbeddingProvider,
  opts?: { minRepos?: number; maxFraction?: number },
): Promise<RouteResult> {
  const minRepos = opts?.minRepos ?? 3;
  const maxFraction = opts?.maxFraction ?? 0.6;
  const total = profileEmbeddings.length;

  // Small repo set: no filtering needed
  if (total <= 10) {
    const scores = new Map<string, number>();
    for (const pe of profileEmbeddings) {
      scores.set(pe.repoName, 1.0);
    }
    return {
      repos: profileEmbeddings.map((pe) => pe.repoName),
      scores,
      strategy: 'all',
    };
  }

  // Embed the query
  const queryEmbedding = await embedder.embedSingle(query);

  // Score each repo
  const scored: Array<{ repoName: string; score: number }> = profileEmbeddings.map(
    (pe) => ({
      repoName: pe.repoName,
      score: cosineSimilarity(queryEmbedding, pe.embedding),
    }),
  );

  // Sort descending by score
  scored.sort((a, b) => b.score - a.score);

  // Compute dynamic threshold: mean + 0.5 * stddev
  const scores = scored.map((s) => s.score);
  const mean = scores.reduce((sum, v) => sum + v, 0) / scores.length;
  const variance =
    scores.reduce((sum, v) => sum + (v - mean) ** 2, 0) / scores.length;
  const stddev = Math.sqrt(variance);
  const threshold = mean + 0.5 * stddev;

  // Filter repos above threshold
  let filtered = scored.filter((s) => s.score >= threshold);

  // Enforce minimum: at least minRepos
  if (filtered.length < minRepos) {
    filtered = scored.slice(0, Math.min(minRepos, total));
  }

  // Enforce maximum: at most maxFraction of total
  const maxCount = Math.ceil(total * maxFraction);
  if (filtered.length > maxCount) {
    filtered = filtered.slice(0, maxCount);
  }

  // Fallback: if somehow empty, return top 5
  if (filtered.length === 0) {
    filtered = scored.slice(0, Math.min(5, total));
  }

  const resultScores = new Map<string, number>();
  for (const s of filtered) {
    resultScores.set(s.repoName, s.score);
  }

  return {
    repos: filtered.map((s) => s.repoName),
    scores: resultScores,
    strategy: 'filtered',
  };
}

// ---------------------------------------------------------------------------
// Cached Router Class
// ---------------------------------------------------------------------------

/**
 * QueryRouter maintains cached profile embeddings and routes queries
 * efficiently. Initialize once per project, reuse across queries.
 */
export class QueryRouter {
  private profileEmbeddings: ProfileEmbedding[] = [];
  private embedder: EmbeddingProvider;
  private initialized = false;

  constructor(embedder: EmbeddingProvider) {
    this.embedder = embedder;
  }

  /**
   * Initialize with profiles. Embeds all profiles (one-time cost).
   */
  async init(profiles: RepoProfile[]): Promise<void> {
    this.profileEmbeddings = await embedProfiles(profiles, this.embedder);
    this.initialized = true;
  }

  /**
   * Load cached embeddings through the blob port (skip re-embedding).
   * Returns true if cache was loaded successfully.
   */
  async loadCached(blobs: BlobStorePort): Promise<boolean> {
    try {
      const data = await blobs.getJson<ProfileEmbedding[]>('profile_embeddings.json');
      if (!Array.isArray(data) || data.length === 0) return false;

      // Validate structure of first entry
      const first = data[0];
      if (
        typeof first.repoName !== 'string' ||
        !Array.isArray(first.embedding) ||
        typeof first.textUsed !== 'string'
      ) {
        return false;
      }

      this.profileEmbeddings = data;
      this.initialized = true;
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Save embeddings through the blob port for future use.
   */
  async saveCached(blobs: BlobStorePort): Promise<void> {
    // putJson pretty-prints (byte-identical to the prior write) + creates parents.
    await blobs.putJson('profile_embeddings.json', this.profileEmbeddings);
  }

  /**
   * Route a query to relevant repos.
   */
  async route(
    query: string,
    opts?: { minRepos?: number; maxFraction?: number },
  ): Promise<RouteResult> {
    if (!this.initialized) {
      return { repos: [], scores: new Map(), strategy: 'all' };
    }
    return routeQuery(query, this.profileEmbeddings, this.embedder, opts);
  }

  /**
   * Get all repo names (for when routing is not needed).
   */
  getAllRepos(): string[] {
    return this.profileEmbeddings.map((pe) => pe.repoName);
  }

  /**
   * Check whether the router has been initialized.
   */
  isReady(): boolean {
    return this.initialized;
  }

  /**
   * Number of repos loaded.
   */
  get repoCount(): number {
    return this.profileEmbeddings.length;
  }
}

// ---------------------------------------------------------------------------
// Integration Helper
// ---------------------------------------------------------------------------

/**
 * Create a ready-to-use query router for a project.
 * Loads profiles from disk, embeds them (or loads cached embeddings),
 * and returns the router. Returns null if no profiles are found.
 */
export async function createQueryRouter(
  project: string,
  embedder: EmbeddingProvider,
  config?: KnowledgeConfig,
): Promise<QueryRouter | null> {
  // Collect repo profiles through the shared (port-backed) loader; keep only
  // those carrying the fields routing needs.
  const profiles = (await loadAllProfiles(project, config)).filter((p) => p.name && p.role);

  if (profiles.length === 0) return null;

  const blobs = resolveStorage(project, config).blobs;
  const router = new QueryRouter(embedder);

  // Try loading cached embeddings first
  if (await router.loadCached(blobs)) {
    // Verify cache is still consistent: same repos, same count
    const cachedRepos = new Set(router.getAllRepos());
    const currentRepos = new Set(profiles.map((p) => p.name));
    const cacheValid =
      cachedRepos.size === currentRepos.size &&
      Array.from(currentRepos).every((r) => cachedRepos.has(r));

    if (cacheValid) {
      return router;
    }
    // Cache is stale; fall through to re-embed
  }

  // Embed all profiles and cache for next time
  await router.init(profiles);
  await router.saveCached(blobs);

  return router;
}
