/**
 * Memory-core canonical types — locked verbatim in MEMORY-CORE-ADR.md §7.
 *
 * Future phases consume these without further negotiation. Keep this file
 * additive only — adding new optional fields is fine; renaming or
 * removing existing ones requires a new ADR section.
 */

// ── Taxonomy ─────────────────────────────────────────────────────────────

/**
 * Five-type memory taxonomy (LangMem split, validated by CoALA).
 *
 * - `working`: in-context only; never persisted.
 * - `episodic`: run events, PR records, observed traces.
 * - `semantic`: facts about the codebase / user. Existing kinds
 *   (fix-pattern, success, approach, flaky-test, performance, manual)
 *   live here as `subtype`.
 * - `procedural`: how-to rules. Sleeptime PROPOSES SKILL.md files via
 *   Plan C's loader; this layer doesn't duplicate the reader.
 * - `profile`: user preferences inferred from interaction history.
 */
export type MemoryKind =
  | 'working'
  | 'episodic'
  | 'semantic'
  | 'procedural'
  | 'profile';

export type SemanticSubtype =
  | 'fix-pattern'
  | 'success'
  | 'approach'
  | 'flaky-test'
  | 'performance'
  | 'manual';

// ── Namespace (LangMem tuple, M14) ───────────────────────────────────────

export interface MemoryNamespace {
  scope: 'global' | 'user' | 'project' | 'repo';
  projectId?: string;
  repoId?: string;
  userId?: string;
}

// ── Provenance ───────────────────────────────────────────────────────────

export interface MemoryProvenance {
  sourceRunId?: string;
  sourceMessageId?: string;
  sourceFile?: string;
  sourceCommit?: string;
  createdBy:
    | 'auto-learner'
    | 'user'
    | 'reflection'
    | 'sleeptime'
    | 'pr-episode'
    | 'migration';
  /** ISO-8601. */
  createdAt: string;
  /** When the proposal was queued (M11). */
  proposedAt?: string;
  /** When sleeptime promoted the proposal to durable storage (M9). */
  ratifiedAt?: string;
  /** Set by `invalidate()` when a memory is soft-deleted (Phase 5). */
  invalidatedBy?: {
    runId?: string;
    reason: string;
  };
}

// ── Code-fact drift detection (M7) ───────────────────────────────────────

export interface CodeFactBinding {
  filePath: string;
  /** Reuses `@anvil/knowledge-core/structural-hasher.ts`. */
  structuralHash: string;
  lastSeenCommitSha: string;
  /** ISO-8601. */
  lastVerifiedAt: string;
}

// ── Bi-temporal markers (M8, Zep pattern) ────────────────────────────────

export interface BiTemporal {
  /** When this fact became true (real-world time). */
  validAt: string;
  /** When this fact became false; undefined = still valid. */
  invalidAt?: string;
}

// ── Decay-and-rehearse (M15, MemoryBank pattern) ─────────────────────────

export interface DecayState {
  /** ISO-8601 of the most recent retrieval. */
  lastAccessed: string;
  /** 0..100; decays with time, refreshes on retrieval. */
  strength: number;
  /** How many times this memory has been retrieved. */
  rehearseCount: number;
}

// ── Memory<T> — the core record ──────────────────────────────────────────

export interface MemoryLink {
  targetId: string;
  relation: string;
  weight: number;
}

/**
 * Well-known relation names for `MemoryLink.relation`. Constants live here
 * so callers (auto-learners, sleeptime, dashboard) don't drift on
 * spelling. New relation strings are allowed; these are just the ones the
 * built-in pipeline uses.
 */
export const MEMORY_LINK_RELATIONS = {
  /**
   * Phase 5: when a new fact contradicts an old one, the new memory's
   * `links` includes `{targetId: <old>, relation: SUPERSEDES, weight: 1}`.
   * Auto-learners + sleeptime then call `invalidate(<old>, ...)` rather
   * than overwriting.
   */
  SUPERSEDES: 'supersedes',
  /** Phase 8: graph linking — references a code fact. */
  REFERENCES: 'references',
  /** Phase 8: graph linking — derived from another memory. */
  DERIVED_FROM: 'derived-from',
} as const;
export type MemoryLinkRelation =
  (typeof MEMORY_LINK_RELATIONS)[keyof typeof MEMORY_LINK_RELATIONS];

export interface Memory<T = string> {
  /** ULID — sortable lexicographically by creation time (ADR §7.10). */
  id: string;
  namespace: MemoryNamespace;
  kind: MemoryKind;
  /** Only populated when `kind === 'semantic'`. */
  subtype?: SemanticSubtype;

  /** Primary payload (string for legacy semantic memory; structured for episodic / procedural). */
  content: T;
  /** Lazy-populated embedding (Phase 8). */
  embedding?: number[];

  tags: string[];
  /** 0..100 confidence (carries forward from existing semantic memory). */
  confidence: number;
  /** -1 = never expires. */
  ttlDays: number;
  /** ISO-8601; computed from `createdAt + ttlDays`. */
  expiresAt: string;

  bitemporal: BiTemporal;
  decay: DecayState;
  codeBinding?: CodeFactBinding;
  provenance: MemoryProvenance;

  /** Graph-related (populated in Phase 8). */
  links?: MemoryLink[];
}

// ── Proposal queue (M9 / M11) ────────────────────────────────────────────

export type ProposalStatus = 'pending' | 'ratified' | 'rejected' | 'merged-into';

export interface Proposal {
  id: string;
  /** The proposed memory; copied verbatim into durable store on ratification. */
  candidate: Memory;
  /** Why the auto-learner thought this was worth saving. */
  reason: string;
  status: ProposalStatus;
  /** Memory id when ratified or merged-into. */
  ratifiedTo?: string;
  rejectedReason?: string;
  /** ISO-8601. */
  proposedAt: string;
  /** ISO-8601. */
  decidedAt?: string;
}

// ── PR-as-episode (Phase 12) ─────────────────────────────────────────────

export interface PrEpisode {
  prUrl: string;
  intent: string;
  plan: string;
  filesChanged: string[];
  commitShas: string[];
  testsAdded: string[];
  ciStatus: 'pass' | 'fail' | 'pending' | 'skipped';
  reviewOutcome?: 'approved' | 'changes-requested' | 'commented';
  mergeStatus?: 'merged' | 'closed' | 'open';
  durationMs: number;
  costUsd: number;
}
