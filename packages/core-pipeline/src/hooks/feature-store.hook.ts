/**
 * Feature-store hook — Phase 4 of core-pipeline consolidation.
 *
 * Subscribes to `artifact:emitted` events and persists known artifact
 * IDs to `<featureDir>/<artifactId>` (or a per-repo subpath when the
 * artifact carries a repoName payload). Replaces the inline writes in
 * the legacy orchestrator's per-stage blocks (e.g. `~/.anvil/features/
 * <project>/<slug>/CLARIFICATION.md`).
 *
 * Fault-tolerant — disk failures never propagate; surfaced via
 * `lastError` for diagnostics.
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { EventBus, EventListener, PipelineEvent } from '../types.js';

export interface FeatureStoreHookOptions {
  /** Absolute path to the feature directory (e.g. `~/.anvil/features/<project>/<slug>`). */
  featureDir: string;
  /**
   * Map of artifact IDs the hook persists. Keys are artifact IDs (e.g.
   * `CLARIFICATION.md`); values are the *relative* path under
   * `featureDir` (e.g. `CLARIFICATION.md` → `CLARIFICATION.md`,
   * `REQUIREMENTS.md` → `REQUIREMENTS.md`). Unknown artifact IDs are
   * ignored (so steps can emit internal artifacts that aren't persisted).
   */
  artifactPaths: Record<string, string>;
  /**
   * Optional transform applied to the artifact data before writing.
   * Defaults to: if data is a string, write as-is; if object with
   * `.artifact` field (the legacy shape), write that field as text;
   * otherwise JSON.stringify(data, null, 2).
   */
  serialize?: (data: unknown) => string;
  /** Override priority. Default 70. */
  priority?: number;
  /** Logger for write failures. */
  onError?: (err: Error, event: PipelineEvent) => void;
}

export interface FeatureStoreHookHandle {
  unsubscribe: () => void;
  readonly lastError: Error | undefined;
  readonly writeCount: number;
  /** Test helper: which artifact IDs have been persisted in this run. */
  readonly persistedArtifacts: ReadonlySet<string>;
}

export function attachFeatureStoreHook(
  bus: EventBus,
  opts: FeatureStoreHookOptions,
): FeatureStoreHookHandle {
  const priority = opts.priority ?? 70;
  const serialize = opts.serialize ?? defaultSerialize;
  const persisted = new Set<string>();
  let lastError: Error | undefined;
  let writeCount = 0;

  ensureDir(opts.featureDir);

  const listener: EventListener = (event) => {
    if (event.hook !== 'artifact:emitted') return;
    const payload = event.payload as { artifactId?: string; data?: unknown } | undefined;
    if (!payload?.artifactId) return;

    const relativePath = opts.artifactPaths[payload.artifactId];
    if (!relativePath) return; // Unknown artifact — ignore.

    const fullPath = join(opts.featureDir, relativePath);
    try {
      ensureDir(dirname(fullPath));
      writeFileSync(fullPath, serialize(payload.data), 'utf8');
      writeCount += 1;
      persisted.add(payload.artifactId);
    } catch (err) {
      lastError = err instanceof Error ? err : new Error(String(err));
      opts.onError?.(lastError, event);
    }
  };

  const off = bus.on('artifact:emitted', listener, { priority });

  return {
    unsubscribe: off,
    get lastError() { return lastError; },
    get writeCount() { return writeCount; },
    persistedArtifacts: persisted,
  };
}

function defaultSerialize(data: unknown): string {
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object' && 'artifact' in data && typeof (data as { artifact: unknown }).artifact === 'string') {
    return (data as { artifact: string }).artifact;
  }
  return JSON.stringify(data, null, 2);
}

function ensureDir(dir: string): void {
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}
