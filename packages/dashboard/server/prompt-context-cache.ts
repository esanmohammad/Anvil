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
  private cachedMemoryBlock: string | null = null;
  private cachedConventionsBlock: string | null = null;
  private cachedProjectYamlSlice: Map<number, string> = new Map();
  private cachedKbBlock: Map<string, string> = new Map();
  private lockedKbTierResolved: 'full' | 'repo-focused' | 'index-only' | null = null;
  private cachedManifestBlock: string | null = null;
  private conventionsMarkdownSync: string | null = null;

  constructor(private readonly opts: PromptContextCacheOptions) {}

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

  /** Memoised memory block (project + user profile, capped at 4KB). */
  getStableMemoryBlock(): string {
    if (this.cachedMemoryBlock !== null) return this.cachedMemoryBlock;
    try {
      const store = this.opts.memoryStore.unwrap();
      const projectNs = { scope: 'project' as const, projectId: this.opts.project };
      const userNs = { scope: 'user' as const, projectId: this.opts.project };
      const queryText = this.opts.feature || '';

      const projectHits = queryText
        ? store.query(projectNs, { text: queryText, limit: 8 })
        : store.query(projectNs, { limit: 8 });
      const userHits = store.query(userNs, { limit: 5 });

      const projectBlock = projectHits.length > 0
        ? `## Recent project memories (BM25-ranked for "${queryText.slice(0, 60)}")\n` +
          projectHits.map((m) => `- [${m.kind}${m.subtype ? `:${m.subtype}` : ''}] ${formatContent(m.content)}`).join('\n')
        : '';
      const userBlock = userHits.length > 0
        ? `## User profile\n` +
          userHits.map((m) => `- ${formatContent(m.content)}`).join('\n')
        : '';

      const combined = [projectBlock, userBlock].filter(Boolean).join('\n\n');
      this.cachedMemoryBlock = combined.length > 4000
        ? combined.slice(0, 4000) + '\n... [memory truncated]'
        : combined;
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
