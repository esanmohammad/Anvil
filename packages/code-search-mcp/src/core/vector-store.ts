import type { CodeChunk, ScoredChunk } from './types';

export class VectorStore {
  private db: any; // lancedb.Connection
  private table: any; // lancedb.Table
  private dbPath: string;
  private initialized: boolean = false;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
  }

  /** Initialize connection, create or open table */
  async init(): Promise<void> {
    let lancedb: typeof import('@lancedb/lancedb');
    try {
      lancedb = await import('@lancedb/lancedb');
    } catch {
      throw new Error(
        '@lancedb/lancedb is not installed. Install it with: npm install @lancedb/lancedb',
      );
    }
    this.db = await lancedb.connect(this.dbPath);
    try {
      this.table = await this.db.openTable('chunks');
      // Ensure FTS index exists for existing tables
      await this.ensureFtsIndex();
      this.initialized = true;
    } catch {
      // Table doesn't exist yet — will be created on first upsert
      this.initialized = true;
    }
  }

  /** Create or rebuild the full-text search index on contextualizedContent */
  private async ensureFtsIndex(): Promise<void> {
    if (!this.table) return;
    try {
      const lancedb = await import('@lancedb/lancedb');
      await this.table.createIndex('contextualizedContent', {
        config: lancedb.Index.fts(),
        replace: true,
      });
    } catch {
      // Index creation can fail on empty tables or unsupported configs — non-fatal
    }
  }

  /** Insert or replace chunks with embeddings */
  async upsertChunks(chunks: Array<CodeChunk & { embedding: number[] }>): Promise<void> {
    // Map chunks to flat row objects for LanceDB
    const rows = chunks.map((c) => ({
      id: c.id,
      vector: c.embedding, // LanceDB uses 'vector' field for embeddings
      content: c.content,
      contextualizedContent: c.contextualizedContent,
      contextPrefix: c.contextPrefix,
      filePath: c.filePath,
      repoName: c.repoName,
      project: c.project,
      entityType: c.entityType,
      entityName: c.entityName ?? '',
      parentEntity: c.parentEntity ?? '',
      language: c.language,
      startLine: c.startLine,
      endLine: c.endLine,
      tokens: c.tokens,
    }));

    if (!this.table) {
      this.table = await this.db.createTable('chunks', rows, { mode: 'overwrite' });
    } else {
      // Delete existing chunks for the same project, then add new ones
      // This handles re-indexing
      const project = chunks[0]?.project;
      if (project) {
        try {
          await this.table.delete(`project = '${project.replace(/'/g, "''")}'`);
        } catch {
          /* ok if empty */
        }
      }
      await this.table.add(rows);
    }
    // Rebuild FTS index after data changes
    await this.ensureFtsIndex();
  }

  /** Semantic vector search */
  async vectorSearch(
    queryEmbedding: number[],
    opts?: {
      limit?: number;
      filter?: string;
    },
  ): Promise<ScoredChunk[]> {
    if (!this.table) return [];
    let query = this.table.search(queryEmbedding).limit(opts?.limit ?? 20);
    if (opts?.filter) query = query.where(opts.filter);
    const results = await query.toArray();
    return results.map((r: any) => ({
      chunk: rowToChunk(r),
      score: r._distance != null ? 1 / (1 + r._distance) : 0.5,
      source: 'vector' as const,
    }));
  }

  /** Full-text BM25 search (LanceDB built-in FTS) */
  async fullTextSearch(queryText: string, limit: number = 20): Promise<ScoredChunk[]> {
    if (!this.table) return [];
    try {
      const results = await this.table
        .search(queryText, 'fts', 'contextualizedContent')
        .limit(limit)
        .toArray();
      return results.map((r: any) => ({
        chunk: rowToChunk(r),
        score: r._relevance_score ?? 0.5,
        source: 'bm25' as const,
      }));
    } catch {
      // FTS index may not exist
      return [];
    }
  }

  /** Get specific chunks by their IDs */
  async getByIds(ids: string[]): Promise<CodeChunk[]> {
    if (!this.table || ids.length === 0) return [];
    const filter = ids.map((id) => `id = '${id}'`).join(' OR ');
    try {
      const results = await this.table.filter(filter).toArray();
      return results.map((r: any) => rowToChunk(r));
    } catch {
      return [];
    }
  }

  /** Look up chunks by repo + file + entity name — for direct AST graph expansion.
   *  Returns ScoredChunks with a fixed graph-expansion score. */
  async getChunksByEntity(
    lookups: Array<{ repoName: string; filePath: string; entityName?: string }>,
  ): Promise<ScoredChunk[]> {
    if (!this.table || lookups.length === 0) return [];
    const esc = (s: string) => s.replace(/'/g, "''");
    const conditions = lookups.map((l) => {
      const base = `repoName = '${esc(l.repoName)}' AND filePath = '${esc(l.filePath)}'`;
      return l.entityName
        ? `(${base} AND entityName = '${esc(l.entityName)}')`
        : `(${base})`;
    });
    try {
      // Query in batches to avoid overly long filters
      const allResults: ScoredChunk[] = [];
      const batchSize = 20;
      for (let i = 0; i < conditions.length; i += batchSize) {
        const batch = conditions.slice(i, i + batchSize).join(' OR ');
        const results = await this.table.filter(batch).limit(batchSize * 2).toArray();
        for (const r of results) {
          allResults.push({
            chunk: rowToChunk(r),
            score: 0.75,
            source: 'graph' as const,
          });
        }
      }
      return allResults;
    } catch {
      return [];
    }
  }

  /** Get all chunks for a specific file in a repo (for incremental comparison) */
  async getChunksByFile(
    repoName: string,
    filePath: string,
  ): Promise<Array<{ id: string; content: string; entityName: string; tokens: number }>> {
    if (!this.table) return [];
    const esc = (s: string) => s.replace(/'/g, "''");
    try {
      const results = await this.table
        .filter(`repoName = '${esc(repoName)}' AND filePath = '${esc(filePath)}'`)
        .toArray();
      return results.map((r: any) => ({
        id: r.id,
        content: r.content,
        entityName: r.entityName || '',
        tokens: r.tokens || 0,
      }));
    } catch {
      return [];
    }
  }

  /** Delete specific chunks by their IDs (for surgical updates) */
  async deleteChunksByIds(ids: string[]): Promise<void> {
    if (!this.table || ids.length === 0) return;
    // Batch deletes to avoid overly long filter strings
    const batchSize = 50;
    for (let i = 0; i < ids.length; i += batchSize) {
      const batch = ids.slice(i, i + batchSize);
      const filter = batch.map((id) => `id = '${id.replace(/'/g, "''")}'`).join(' OR ');
      try {
        await this.table.delete(filter);
      } catch { /* ok if chunk doesn't exist */ }
    }
  }

  /** Get all chunk IDs for a project (for incremental diff) */
  async getChunkIds(project: string): Promise<string[]> {
    if (!this.table) return [];
    try {
      const escapedProject = project.replace(/'/g, "''");
      const results = await this.table
        .query()
        .where(`project = '${escapedProject}'`)
        .select(['id'])
        .toArray();
      return results.map((r: any) => r.id as string);
    } catch {
      return [];
    }
  }

  /** Get index statistics */
  async getStats(): Promise<{ rowCount: number } | null> {
    if (!this.table) return null;
    try {
      const count = await this.table.countRows();
      return { rowCount: count };
    } catch {
      return null;
    }
  }

  /** Check if the store has data */
  async hasData(): Promise<boolean> {
    const stats = await this.getStats();
    return (stats?.rowCount ?? 0) > 0;
  }

  /** Delete chunks for specific files within a repo (for incremental re-indexing) */
  async deleteFileChunks(project: string, repoName: string, filePaths: string[]): Promise<void> {
    if (!this.table || filePaths.length === 0) return;
    const escapedProject = project.replace(/'/g, "''");
    const escapedRepo = repoName.replace(/'/g, "''");
    const fileFilter = filePaths.map((f) => `'${f.replace(/'/g, "''")}'`).join(', ');
    try {
      await this.table.delete(
        `project = '${escapedProject}' AND repoName = '${escapedRepo}' AND filePath IN (${fileFilter})`,
      );
    } catch {
      /* ok if empty */
    }
  }

  /** Add chunks without deleting existing project data (for incremental updates) */
  async addChunks(chunks: Array<CodeChunk & { embedding: number[] }>): Promise<void> {
    if (chunks.length === 0) return;
    const rows = chunks.map((c) => ({
      id: c.id,
      vector: c.embedding,
      content: c.content,
      contextualizedContent: c.contextualizedContent,
      contextPrefix: c.contextPrefix,
      filePath: c.filePath,
      repoName: c.repoName,
      project: c.project,
      entityType: c.entityType,
      entityName: c.entityName ?? '',
      parentEntity: c.parentEntity ?? '',
      language: c.language,
      startLine: c.startLine,
      endLine: c.endLine,
      tokens: c.tokens,
    }));

    if (!this.table) {
      this.table = await this.db.createTable('chunks', rows, { mode: 'overwrite' });
    } else {
      await this.table.add(rows);
    }
    // Rebuild FTS index after data changes
    await this.ensureFtsIndex();
  }
}

function rowToChunk(row: any): CodeChunk {
  return {
    id: row.id,
    filePath: row.filePath,
    repoName: row.repoName,
    project: row.project,
    startLine: row.startLine,
    endLine: row.endLine,
    content: row.content,
    contextPrefix: row.contextPrefix,
    contextualizedContent: row.contextualizedContent,
    language: row.language,
    entityType: row.entityType,
    entityName: row.entityName || undefined,
    parentEntity: row.parentEntity || undefined,
    tokens: row.tokens,
    imports: [],
    exports: [],
  };
}
