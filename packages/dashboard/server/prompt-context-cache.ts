/**
 * `PromptContextCache` — memoised inputs to the system prompt.
 *
 * The provider's prompt cache only fires when the system-prompt bytes
 * are byte-identical across stages. The runner threads multiple stable
 * blocks (memory, conventions, project YAML slice, KB block, manifest)
 * into every system prompt; this class owns the per-run memoization
 * that keeps those bytes stable.
 *
 * Constructor takes the small dep set the cache needs. The runner
 * keeps owning `this.state` mutation, FS writes, and WS broadcasts.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  extractConventions as coreExtractConventions,
  loadConventions as coreLoadConventions,
} from '@esankhan3/anvil-convention-core';
import { renderManifestForPrompt } from './feature-manifest.js';
import type { FeatureManifestStore } from './feature-manifest.js';
import type { KnowledgeBaseManager } from './knowledge-base-manager.js';
import type { MemoryStore } from './memory-store.js';
import type { StageDefinition } from './pipeline-runner-types.js';

export interface PromptContextCacheOptions {
  project: string;
  feature: string;
  memoryStore: MemoryStore;
  kbManager: KnowledgeBaseManager | null;
  manifestStore: FeatureManifestStore;
  /** Project YAML to slice from. */
  projectYaml: string;
  /** Repo paths used by `warmConventions()` to detect first-run extraction. */
  repoPaths: () => Record<string, string>;
  /** Feature slug — read at lookup time so resume scenarios pick up the right slug. */
  featureSlug: () => string;
  /** Optional events sink. */
  emitProjectEvent?: (level: 'info' | 'warn', message: string) => void;
}

/** Source label rendered into prompt comments + telemetry. */
export type KbSourceLabel = 'none' | 'repo-focused' | 'index-only' | 'full-with-index' | 'full-blob';

/** Render project + user-profile memories into the system-prompt block.
 *  Shared by the async hybrid warm path and the sync BM25 fallback. */
function renderMemoryBlock(
  projectHits: ReadonlyArray<{ kind: string; subtype?: string; content: unknown }>,
  userHits: ReadonlyArray<{ content: unknown }>,
  queryText: string,
  budgetBytes: number = 4000,
): string {
  const projectBlock = projectHits.length > 0
    ? `## Recent project memories (hybrid-ranked for "${queryText.slice(0, 60)}")\n` +
      projectHits.map((m) => `- [${m.kind}${m.subtype ? `:${m.subtype}` : ''}] ${formatContent(m.content)}`).join('\n')
    : '';
  const userBlock = userHits.length > 0
    ? `## User profile\n` +
      userHits.map((m) => `- ${formatContent(m.content)}`).join('\n')
    : '';
  const combined = [projectBlock, userBlock].filter(Boolean).join('\n\n');
  return combined.length > budgetBytes
    ? combined.slice(0, budgetBytes) + '\n... [memory truncated]'
    : combined;
}

// ── Wave 1: per-stage memory policy ─────────────────────────────────────

interface MemoryKindFilter {
  kind: 'semantic' | 'episodic' | 'profile' | 'procedural';
  subtype?: string;
}

interface StageMemoryPolicy {
  /** Stages where this policy applies. */
  stages: string[];
  /** Which memory shapes are interesting. Higher position = higher priority. */
  filters: MemoryKindFilter[];
  /** Max memories to inject. */
  limit: number;
  /** Bytes budget for the rendered block. Shorter for ship, larger for implement. */
  budgetBytes: number;
}

/**
 * Stage-tuned memory shaping. Each stage gets a block filtered to the
 * memory kinds that benefit it most, capped at a sensible budget.
 *
 *   - **clarify**:  past PR episodes + profile (planning context)
 *   - **requirements / repo-requirements / specs / tasks**: balanced
 *   - **build**:    fix-patterns + successes + approaches (code patterns)
 *   - **test / validate**: flaky-test + success (test-relevant memory)
 *   - **ship**:     PR episodes only — short prompt, no code memory
 *
 * Stages not listed fall back to the `pipeline` (no-filter) default
 * block — same as today's pre-Wave-1 behavior.
 */
const STAGE_POLICIES: StageMemoryPolicy[] = [
  {
    stages: ['clarify'],
    filters: [{ kind: 'episodic' }, { kind: 'profile' }],
    limit: 10,
    budgetBytes: 4000,
  },
  {
    stages: ['requirements', 'repo-requirements', 'specs', 'tasks'],
    filters: [
      { kind: 'semantic', subtype: 'approach' },
      { kind: 'semantic', subtype: 'success' },
      { kind: 'episodic' },
      { kind: 'profile' },
    ],
    limit: 10,
    budgetBytes: 4000,
  },
  {
    stages: ['build'],
    filters: [
      { kind: 'semantic', subtype: 'fix-pattern' },
      { kind: 'semantic', subtype: 'success' },
      { kind: 'semantic', subtype: 'approach' },
      { kind: 'semantic', subtype: 'performance' },
    ],
    limit: 14,
    budgetBytes: 6000,
  },
  {
    stages: ['test', 'validate'],
    filters: [
      { kind: 'semantic', subtype: 'flaky-test' },
      { kind: 'semantic', subtype: 'success' },
      { kind: 'semantic', subtype: 'fix-pattern' },
    ],
    limit: 10,
    budgetBytes: 3000,
  },
  {
    stages: ['ship'],
    filters: [{ kind: 'episodic' }],
    limit: 5,
    budgetBytes: 2000,
  },
];

function policyForStage(stageName: string): StageMemoryPolicy | null {
  return STAGE_POLICIES.find((p) => p.stages.includes(stageName)) ?? null;
}

/** Prepend a non-empty constraints block to the memory block. */
function joinConstraints(constraints: string, memory: string): string {
  if (!constraints) return memory;
  if (!memory) return constraints;
  return `${constraints}\n\n${memory}`;
}

/**
 * Wave 3 — render a "Hard constraints" block from SUPERSEDES links +
 * drift-flagged memories. Prepended to the regular memory block so
 * the agent reads enforcement rules FIRST, before suggestion-grade
 * hints. Returns '' when no constraints apply.
 *
 * SUPERSEDES guard: for each injected memory whose `links` include a
 * SUPERSEDES relation, look up the targeted (deprecated) memory and
 * emit "Do not use: X. Use instead: Y." Caps at 5 such pairs per
 * stage to avoid prompt bloat.
 *
 * Drift veto: for each injected memory whose `decay.strength < 50`
 * AND has a non-null `codeBinding`, emit a "stale memory" note
 * naming the bound file so the agent re-reads before applying.
 */
function renderConstraintsBlock(
  hits: ReadonlyArray<{ id: string; content: unknown; links?: Array<{ relation: string; targetId: string }>; decay?: { strength: number }; codeBinding?: { filePath: string; lastVerifiedAt: string } | null }>,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  store: any,
  maxConstraints: number = 5,
): string {
  const supersedes: string[] = [];
  const drifts: string[] = [];
  for (const m of hits) {
    if (supersedes.length + drifts.length >= maxConstraints) break;
    const links = m.links ?? [];
    for (const l of links) {
      if (l.relation !== 'supersedes') continue;
      const old = store.findById?.(l.targetId);
      if (!old) continue;
      supersedes.push(
        `- **Do not use:** ${formatContent(old.content)}\n  **Use instead:** ${formatContent(m.content)}`,
      );
      if (supersedes.length + drifts.length >= maxConstraints) break;
    }
    if (m.codeBinding && m.decay && m.decay.strength < 50) {
      drifts.push(
        `- \`${m.codeBinding.filePath}\` has a stale memory (decay strength ${m.decay.strength}/100, last verified ${m.codeBinding.lastVerifiedAt.slice(0, 10)}). Re-read the current code before applying any remembered pattern.`,
      );
    }
  }
  if (supersedes.length === 0 && drifts.length === 0) return '';
  const sections: string[] = ['## Hard constraints — do not violate'];
  if (supersedes.length > 0) {
    sections.push('### Replaced patterns', supersedes.join('\n'));
  }
  if (drifts.length > 0) {
    sections.push('### Files with stale memory — verify before editing', drifts.join('\n'));
  }
  return sections.join('\n');
}

/**
 * Wave 2 — render the build-stage memory block with code-bound
 * memories explicitly called out as "files you're about to touch."
 * The agent reads this BEFORE the general project memories, so even
 * a weak / low-decay memory bound to `auth.ts` surfaces above an
 * unrelated high-BM25 hit when the diff touches auth.ts.
 */
function renderCodeAwareMemoryBlock(
  hits: ReadonlyArray<{ kind: string; subtype?: string; content: unknown }>,
  codeBoundCount: number,
  touchedFiles: readonly string[],
  budgetBytes: number,
): string {
  if (hits.length === 0) return '';
  const codeBound = hits.slice(0, codeBoundCount);
  const general = hits.slice(codeBoundCount);
  const codeHeader = codeBound.length > 0
    ? `## Memories about files this stage will touch (${touchedFiles.slice(0, 3).join(', ')}${touchedFiles.length > 3 ? '…' : ''})\n` +
      codeBound.map((m) => `- [${m.kind}${m.subtype ? `:${m.subtype}` : ''}] ${formatContent(m.content)}`).join('\n')
    : '';
  const generalBlock = general.length > 0
    ? `## Other relevant project memories\n` +
      general.map((m) => `- [${m.kind}${m.subtype ? `:${m.subtype}` : ''}] ${formatContent(m.content)}`).join('\n')
    : '';
  const combined = [codeHeader, generalBlock].filter(Boolean).join('\n\n');
  return combined.length > budgetBytes
    ? combined.slice(0, budgetBytes) + '\n... [memory truncated]'
    : combined;
}

/** Match a memory against a kind/subtype filter. */
function matchesFilter(
  m: { kind: string; subtype?: string },
  f: MemoryKindFilter,
): boolean {
  if (m.kind !== f.kind) return false;
  if (f.subtype && m.subtype !== f.subtype) return false;
  return true;
}

/**
 * Slice a pool of hybrid-ranked hits into the per-stage subset. The
 * filter order encodes priority — earlier filters fill the budget
 * first. Within a filter, hybrid rank is preserved.
 */
function sliceForPolicy(
  hits: ReadonlyArray<{ kind: string; subtype?: string }>,
  policy: StageMemoryPolicy,
): Array<{ kind: string; subtype?: string }> {
  const selected: typeof hits[number][] = [];
  const seen = new Set<typeof hits[number]>();
  for (const f of policy.filters) {
    for (const m of hits) {
      if (seen.has(m)) continue;
      if (matchesFilter(m, f)) {
        selected.push(m);
        seen.add(m);
        if (selected.length >= policy.limit) return selected;
      }
    }
  }
  return selected;
}

function formatContent(content: unknown): string {
  // Memory entries hold strings for narrative/episodic kinds but
  // structured objects for `semantic:fix-pattern` (`{error, fix}`)
  // and similar typed candidates from `reflectOnRun` /
  // sleeptime consolidation. JSON-stringify the non-string cases so
  // the BM25 retrieval block still renders something useful.
  const text = typeof content === 'string'
    ? content
    : (() => { try { return JSON.stringify(content) ?? ''; } catch { return ''; } })();
  return text.replace(/\s+/g, ' ').trim().slice(0, 280);
}

export class PromptContextCache {
  // Memoised blocks — reset implicitly when a fresh runner constructs a new cache.
  // `cachedMemoryBlock` is the catch-all (Wave-1: "pipeline" default block);
  // `cachedStageMemoryBlocks` holds per-stage tuned blocks when warm has
  // computed them. Sync getter falls back to the default when a stage
  // is requested but no per-stage block was computed.
  private cachedMemoryBlock: string | null = null;
  private cachedStageMemoryBlocks: Map<string, string> = new Map();
  private cachedConventionsBlock: string | null = null;
  private cachedProjectYamlSlice: Map<number, string> = new Map();
  private cachedKbBlock: Map<string, string> = new Map();
  private lockedKbTierResolved: 'full' | 'repo-focused' | 'index-only' | null = null;
  private cachedManifestBlock: string | null = null;
  private conventionsMarkdownSync: string | null = null;
  /**
   * Wave 4 — ids of memories that made it into each stage's cached
   * block. `'pipeline'` key holds the default (catch-all) set. Read by
   * the pipeline runner to record per-stage injections in the
   * memory-core injection log. Empty when warm hasn't run or fell back
   * to BM25.
   */
  private injectedMemoryIdsByStage: Map<string, string[]> = new Map();
  /**
   * Wave 2 — file paths the plan stage said the implement stage will
   * touch. Threaded by the runner after plan completes; consumed by
   * the next `warmMemoryBlock` re-warm (or by a delayed implement-
   * stage call to `getStableMemoryBlock('build')`). Empty by default;
   * code-bound lookup is skipped when empty.
   */
  private touchedFiles: string[] = [];

  constructor(private readonly opts: PromptContextCacheOptions) {}

  /**
   * Provide files the implement / build stage will edit. Triggers a
   * re-warm of the per-stage block for the build stage on next access
   * so code-bound memories surface first regardless of BM25 rank.
   */
  setTouchedFiles(files: readonly string[]): void {
    this.touchedFiles = [...files];
    // Invalidate the build-stage cache so the next read recomputes
    // with the file targeting. Pipeline-default + other stages stay
    // valid (no behavioral dependency on touched files).
    this.cachedStageMemoryBlocks.delete('build');
    this.injectedMemoryIdsByStage.delete('build');
    void this.rewarmBuildStage().catch((err) => {
      console.warn('[pipeline] build-stage memory re-warm failed:', err);
    });
  }

  /** Internal: compute the build stage's memory block with code-bound
   *  memories surfaced first. Called from `setTouchedFiles`. */
  private async rewarmBuildStage(): Promise<void> {
    const store = this.opts.memoryStore.unwrap();
    const projectNs = { scope: 'project' as const, projectId: this.opts.project };
    const policy = policyForStage('build');
    if (!policy) return;
    // Per-file code-bound memories — up to 4 per file, capped at 12 total
    // before union with the hybrid pool. Strongest-decay first via the
    // SQLite query's ORDER BY strength DESC.
    const codeBound: Array<{ id: string; kind: string; subtype?: string; content: unknown }> = [];
    const seen = new Set<string>();
    for (const file of this.touchedFiles) {
      const hits = store.findByCodeBindingFile(file, { namespace: projectNs, limit: 4 });
      for (const m of hits) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        codeBound.push(m);
        if (codeBound.length >= 12) break;
      }
      if (codeBound.length >= 12) break;
    }
    // Fall back to the policy-filtered hybrid hits for the remainder of
    // the budget.
    let hybridHits: Array<{ id: string; kind: string; subtype?: string; content: unknown }> = [];
    try {
      const { hybridSearch } = await import('@esankhan3/anvil-memory-core');
      const queryText = this.opts.feature || '';
      if (queryText) {
        const pool = await hybridSearch(store, queryText, {
          namespace: projectNs,
          limit: 30,
          bm25Limit: 20,
          vectorLimit: 20,
          graphLimit: 10,
        });
        hybridHits = (sliceForPolicy(pool, policy) as typeof pool).filter((m) => !seen.has(m.id));
      }
    } catch {
      // Hybrid re-query failure — code-bound alone is still useful.
    }
    const combined = [...codeBound, ...hybridHits].slice(0, policy.limit);
    const constraints = renderConstraintsBlock(combined, store);
    const memoryBlock = renderCodeAwareMemoryBlock(
      combined,
      codeBound.length,
      this.touchedFiles,
      policy.budgetBytes,
    );
    this.cachedStageMemoryBlocks.set('build', joinConstraints(constraints, memoryBlock));
    this.injectedMemoryIdsByStage.set('build', combined.map((m) => m.id));
  }

  /** Ids of memories injected for a stage (or 'pipeline' default). */
  getInjectedMemoryIds(stageName: string = 'pipeline'): readonly string[] {
    return this.injectedMemoryIdsByStage.get(stageName)
      ?? this.injectedMemoryIdsByStage.get('pipeline')
      ?? [];
  }

  /** All (stage, ids) pairs the runner needs to bulk-record at run start. */
  getAllInjectedMemoryIds(): ReadonlyMap<string, readonly string[]> {
    return this.injectedMemoryIdsByStage;
  }

  /**
   * KB tier locked for the run. Stages 1–7 share one tier so the KB
   * subsection is byte-stable across them.
   */
  getLockedKbTier(stage: StageDefinition): 'full' | 'repo-focused' | 'index-only' | 'none' {
    if (stage.name === 'ship') return 'none';
    if (stage.name === 'clarify') return 'index-only';
    if (this.lockedKbTierResolved !== null) return this.lockedKbTierResolved;
    this.lockedKbTierResolved = 'repo-focused';
    return this.lockedKbTierResolved;
  }

  /**
   * Warm the memory block via `hybridSearch` (BM25 + vector + 1-hop graph
   * expansion → RRF fusion). Called once at pipeline start, before any
   * stage's sync `getStableMemoryBlock()` lookup. If this runs to
   * completion, the sync getter returns the hybrid-ranked block; if it
   * fails or isn't called, the sync getter falls back to raw BM25
   * (legacy behavior). Either way the prompt cache stays byte-stable
   * across stages.
   *
   * Graph expansion fires even when the vector stream is stubbed —
   * 1-hop SUPERSEDES / REFERENCES / DERIVED_FROM neighbors of BM25
   * seeds surface linked memories raw `store.query()` can't reach.
   */
  async warmMemoryBlock(): Promise<void> {
    if (this.cachedMemoryBlock !== null) return;
    try {
      const { hybridSearch } = await import('@esankhan3/anvil-memory-core');
      const store = this.opts.memoryStore.unwrap();
      const projectNs = { scope: 'project' as const, projectId: this.opts.project };
      const userNs = { scope: 'user' as const, projectId: this.opts.project };
      const queryText = this.opts.feature || '';

      // Single hybrid query → larger pool. Each stage slices its own
      // subset from the same pool via the filter ladder. Saves ~8x
      // hybridSearch invocations vs querying per stage.
      const POOL_LIMIT = 30;
      const projectHits = queryText
        ? await hybridSearch(store, queryText, {
            namespace: projectNs,
            limit: POOL_LIMIT,
            bm25Limit: 20,
            vectorLimit: 20,
            graphLimit: 10,
            bm25Weight: 1.0,
            vectorWeight: 1.0,
            graphWeight: 0.5,
          })
        : store.query(projectNs, { limit: POOL_LIMIT });
      // User-profile memories are short, linked rarely; raw BM25 is fine.
      const userHits = store.query(userNs, { limit: 5 });

      // Default "pipeline" block — top 8 by hybrid rank, no filter.
      // Mirrors today's pre-Wave-1 behavior so unknown stages still
      // get a usable block.
      const defaultProjectHits = projectHits.slice(0, 8);
      const defaultConstraints = renderConstraintsBlock(defaultProjectHits, store);
      this.cachedMemoryBlock = joinConstraints(
        defaultConstraints,
        renderMemoryBlock(defaultProjectHits, userHits, queryText),
      );
      this.injectedMemoryIdsByStage.set('pipeline', [
        ...defaultProjectHits.map((m) => m.id),
        ...userHits.map((m) => m.id),
      ]);

      // Per-stage blocks: filter the pool through each policy. Each
      // also gets its own constraints block — different stages may
      // surface different SUPERSEDES pairs depending on which memories
      // pass the kind/subtype filter.
      for (const policy of STAGE_POLICIES) {
        const sliced = sliceForPolicy(projectHits, policy) as typeof projectHits;
        const includeUser = policy.filters.some((f) => f.kind === 'profile');
        const userForStage = includeUser ? userHits : [];
        const constraintsBlock = renderConstraintsBlock(sliced, store);
        const memoryBlock = renderMemoryBlock(sliced, userForStage, queryText, policy.budgetBytes);
        const rendered = joinConstraints(constraintsBlock, memoryBlock);
        const ids = [
          ...sliced.map((m) => m.id),
          ...userForStage.map((m) => m.id),
        ];
        for (const stageName of policy.stages) {
          this.cachedStageMemoryBlocks.set(stageName, rendered);
          this.injectedMemoryIdsByStage.set(stageName, ids);
        }
      }
    } catch (err) {
      console.warn('[pipeline] hybrid memory warm failed (will fall back to BM25):', err);
      // Leave cache null so the sync getter computes BM25 fallback.
    }
  }

  /**
   * Memoised memory block. When called with a stage name, returns the
   * Wave-1 tuned per-stage block (build → code patterns, ship → PR
   * history, etc.). Without a stage, returns the pipeline-wide
   * default — same as pre-Wave-1 behavior.
   *
   * If `warmMemoryBlock()` ran successfully at pipeline start, this
   * is a Map lookup (zero IO). Otherwise it computes a BM25-only
   * fallback block on first call and caches.
   */
  getStableMemoryBlock(stageName?: string): string {
    // Per-stage cache hit?
    if (stageName) {
      const stageBlock = this.cachedStageMemoryBlocks.get(stageName);
      if (stageBlock !== undefined) return stageBlock;
      // Stage known but warm didn't compute a block (warm failed or this
      // stage isn't in STAGE_POLICIES) → fall through to the default.
    }
    if (this.cachedMemoryBlock !== null) return this.cachedMemoryBlock;

    // BM25 fallback — fires when warm failed or no stage was known.
    try {
      const store = this.opts.memoryStore.unwrap();
      const projectNs = { scope: 'project' as const, projectId: this.opts.project };
      const userNs = { scope: 'user' as const, projectId: this.opts.project };
      const queryText = this.opts.feature || '';

      const projectHits = queryText
        ? store.query(projectNs, { text: queryText, limit: 8 })
        : store.query(projectNs, { limit: 8 });
      const userHits = store.query(userNs, { limit: 5 });
      this.cachedMemoryBlock = renderMemoryBlock(projectHits, userHits, queryText);
      this.injectedMemoryIdsByStage.set('pipeline', [
        ...projectHits.map((m) => m.id),
        ...userHits.map((m) => m.id),
      ]);
    } catch (err) {
      console.warn('[pipeline] BM25 memory retrieval failed:', err);
      this.cachedMemoryBlock = '';
    }
    return this.cachedMemoryBlock;
  }

  /** Memoised conventions block. */
  getStableConventionsBlock(): string {
    if (this.cachedConventionsBlock !== null) return this.cachedConventionsBlock;
    const md = this.conventionsMarkdownSync ?? '';
    this.cachedConventionsBlock = md.length > 8000
      ? md.slice(0, 8000) + '\n... [conventions truncated]'
      : md;
    return this.cachedConventionsBlock;
  }

  /**
   * Warm the conventions cache. If `<conventionsDir>/<project>/conventions.md`
   * is missing, extract it from the workspace; then load + cache the markdown.
   */
  async warmConventions(): Promise<void> {
    const anvilHome = process.env.ANVIL_HOME ?? process.env.FF_HOME ?? join(homedir(), '.anvil');
    const paths = {
      conventionsDir: join(anvilHome, 'conventions'),
      rulesDir: join(anvilHome, 'conventions', 'rules'),
    };
    const projectMd = join(paths.conventionsDir, this.opts.project, 'conventions.md');

    if (!existsSync(projectMd)) {
      try {
        const repoPathValues = Object.values(this.opts.repoPaths());
        if (repoPathValues.length > 0 && repoPathValues.every((p) => existsSync(p))) {
          this.opts.emitProjectEvent?.('info', `Extracting conventions for "${this.opts.project}" (first run)`);
          coreExtractConventions(paths, this.opts.project, repoPathValues);
        }
      } catch (err) {
        console.warn('[pipeline] convention extract failed:', err);
      }
    }

    try {
      const md = await coreLoadConventions(paths, this.opts.project);
      this.conventionsMarkdownSync = md;
    } catch {
      this.conventionsMarkdownSync = '';
    }
  }

  /** Memoised project YAML slice — same maxLen returns same bytes. */
  getStableProjectYamlSlice(maxLen: number): string {
    const cached = this.cachedProjectYamlSlice.get(maxLen);
    if (cached !== undefined) return cached;
    const value = this.opts.projectYaml.slice(0, maxLen) || '(not available)';
    this.cachedProjectYamlSlice.set(maxLen, value);
    return value;
  }

  /** Memoised KB block keyed by (tier, repoName). */
  getStableKbBlock(
    tier: 'full' | 'repo-focused' | 'index-only' | 'none',
    repoName?: string,
  ): { content: string; sourceLabel: KbSourceLabel } {
    if (tier === 'none') return { content: '', sourceLabel: 'none' };
    const key = `${tier}|${repoName ?? '__project__'}`;

    const cached = this.cachedKbBlock.get(key);
    if (cached !== undefined) {
      const label = (cached.match(/^<!-- anvil:kb-src:(\w[\w-]*) -->/) ?? [])[1] as
        KbSourceLabel | undefined;
      const content = cached.replace(/^<!-- anvil:kb-src:[\w-]+ -->\n?/, '');
      return { content, sourceLabel: label ?? 'none' };
    }

    let content = '';
    let sourceLabel: KbSourceLabel = 'none';
    const indexPrompt = this.opts.kbManager?.getIndexForPrompt(this.opts.project) || '';

    if (repoName) {
      const repoKB = this.opts.kbManager?.getGraphReport(this.opts.project, repoName) || '';
      if (tier === 'repo-focused') {
        content = repoKB ? `## YOUR TARGET REPO: ${repoName}\n\n${repoKB}` : '';
        if (content) sourceLabel = 'repo-focused';
      } else if (tier === 'index-only') {
        content = indexPrompt;
        if (content) sourceLabel = 'index-only';
      } else if (indexPrompt) {
        const queryContext = this.opts.kbManager?.getQueryContextForPrompt(this.opts.project, this.opts.feature) || '';
        content = `${indexPrompt}\n\n---\n\n## YOUR TARGET REPO: ${repoName}\n\n${repoKB || '(no repo-specific KB)'}\n\n---\n\n${queryContext}`;
        sourceLabel = 'full-with-index';
      } else {
        const fullKB = this.opts.kbManager?.getAllGraphReports(this.opts.project) || '';
        if (repoKB) {
          content = `## YOUR TARGET REPO: ${repoName}\n\n${repoKB}`;
          const otherRepos = fullKB.split('\n\n---\n\n').filter((s) => !s.includes(`## ${repoName}\n`));
          if (otherRepos.length > 0) {
            content += `\n\n---\n\n## OTHER REPOS (for cross-repo context)\n\n${otherRepos.join('\n\n---\n\n')}`;
          }
        } else {
          content = fullKB;
        }
        if (content) sourceLabel = 'full-blob';
      }
    } else {
      // Project-wide (non-repo) prompt path. Honor the tier here too —
      // previously this branch always emitted indexPrompt + queryContext
      // regardless of tier, so `clarify` (locked to `index-only`)
      // silently got the full hybrid-retrieval payload and the log line
      // printed a misleading `tier=index-only, source=full-with-index`.
      if (tier === 'index-only') {
        content = indexPrompt;
        if (content) sourceLabel = 'index-only';
      } else if (indexPrompt) {
        const queryContext = this.opts.kbManager?.getQueryContextForPrompt(this.opts.project, this.opts.feature) || '';
        content = `${indexPrompt}\n\n---\n\n${queryContext}`;
        sourceLabel = 'full-with-index';
      } else {
        content = this.opts.kbManager?.getAllGraphReports(this.opts.project) || '';
        if (content) sourceLabel = 'full-blob';
      }
    }

    if (content) {
      this.cachedKbBlock.set(key, `<!-- anvil:kb-src:${sourceLabel} -->\n${content}`);
    }
    return { content, sourceLabel };
  }

  /** Render the current feature manifest as a stable text block. */
  getStableManifestBlock(): string {
    if (this.cachedManifestBlock !== null) return this.cachedManifestBlock;
    try {
      const m = this.opts.manifestStore.read(this.opts.project, this.opts.featureSlug());
      this.cachedManifestBlock = renderManifestForPrompt(m);
    } catch {
      this.cachedManifestBlock = '';
    }
    return this.cachedManifestBlock;
  }

  /** Discard the cached manifest render so the next read picks up patched fields. */
  invalidateManifestBlock(): void {
    this.cachedManifestBlock = null;
  }
}
