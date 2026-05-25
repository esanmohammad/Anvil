/**
 * SQLite hot-index schema. Embedded as a TS string to avoid a build-time
 * file-copy step. Applied idempotently on every open.
 *
 * Source-of-truth columns track ADR §7's `Memory<T>`. FTS5 virtual table
 * provides BM25 ranking for `searchByText`. Tag table is the many-to-many
 * fan-out from `Memory.tags`. Edge + proposal tables are forward-declared
 * (consumed by Phases 8 + 10).
 */

export const SCHEMA_VERSION = 2;

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  namespace_scope TEXT NOT NULL,
  namespace_project TEXT,
  namespace_repo TEXT,
  namespace_user TEXT,
  kind TEXT NOT NULL,
  subtype TEXT,
  content_json TEXT NOT NULL,
  tags_json TEXT NOT NULL,
  confidence INTEGER NOT NULL,
  ttl_days INTEGER NOT NULL,
  expires_at TEXT NOT NULL,
  valid_at TEXT NOT NULL,
  invalid_at TEXT,
  last_accessed TEXT NOT NULL,
  strength INTEGER NOT NULL,
  rehearse_count INTEGER NOT NULL DEFAULT 0,
  code_file TEXT,
  code_structural_hash TEXT,
  code_last_seen_sha TEXT,
  code_last_verified_at TEXT,
  prov_run_id TEXT,
  prov_message_id TEXT,
  prov_file TEXT,
  prov_commit TEXT,
  prov_created_by TEXT NOT NULL,
  prov_created_at TEXT NOT NULL,
  prov_proposed_at TEXT,
  prov_ratified_at TEXT,
  prov_invalidated_run_id TEXT,
  prov_invalidated_reason TEXT,
  embedding_id TEXT
);

CREATE INDEX IF NOT EXISTS idx_memory_namespace
  ON memory(namespace_scope, namespace_project, namespace_repo, namespace_user);
CREATE INDEX IF NOT EXISTS idx_memory_kind ON memory(kind);
CREATE INDEX IF NOT EXISTS idx_memory_subtype ON memory(subtype);
CREATE INDEX IF NOT EXISTS idx_memory_expires ON memory(expires_at);
CREATE INDEX IF NOT EXISTS idx_memory_valid ON memory(valid_at, invalid_at);
CREATE INDEX IF NOT EXISTS idx_memory_code_file ON memory(code_file);
CREATE INDEX IF NOT EXISTS idx_memory_strength ON memory(strength);

CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
  id UNINDEXED,
  content_text,
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS memory_tag (
  memory_id TEXT NOT NULL,
  tag TEXT NOT NULL,
  PRIMARY KEY (memory_id, tag)
);
CREATE INDEX IF NOT EXISTS idx_tag ON memory_tag(tag);

CREATE TABLE IF NOT EXISTS memory_edge (
  source_id TEXT NOT NULL,
  target_id TEXT NOT NULL,
  relation TEXT NOT NULL,
  weight REAL NOT NULL DEFAULT 1.0,
  valid_at TEXT NOT NULL,
  invalid_at TEXT,
  PRIMARY KEY (source_id, target_id, relation, valid_at)
);
CREATE INDEX IF NOT EXISTS idx_edge_source ON memory_edge(source_id);
CREATE INDEX IF NOT EXISTS idx_edge_target ON memory_edge(target_id);

CREATE TABLE IF NOT EXISTS proposal (
  id TEXT PRIMARY KEY,
  candidate_json TEXT NOT NULL,
  reason TEXT NOT NULL,
  status TEXT NOT NULL,
  ratified_to TEXT,
  rejected_reason TEXT,
  proposed_at TEXT NOT NULL,
  decided_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_proposal_status ON proposal(status, proposed_at);

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

-- ── Memory injection log (Wave 4) ──────────────────────────────────────
-- Tracks which memories were injected into which (run, stage) prompts,
-- and whether the agent's subsequent output used them. Updated by:
--   recordInjection(run, stage, memoryIds) — at warm time
--   markUsed(run, memoryId)               — post-run after hit detection
-- Hit ratio per kind/subtype rolls up via a JOIN against the memory table.
CREATE TABLE IF NOT EXISTS memory_injection (
  run_id      TEXT NOT NULL,
  stage       TEXT NOT NULL,
  memory_id   TEXT NOT NULL,
  injected_at TEXT NOT NULL,
  used        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, stage, memory_id)
);
CREATE INDEX IF NOT EXISTS idx_memory_injection_memory ON memory_injection(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_injection_run ON memory_injection(run_id);
`;
