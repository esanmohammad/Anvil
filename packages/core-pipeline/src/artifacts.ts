/**
 * In-memory artifact store — backs `StepContext.artifacts` + `StepContext.emit`.
 *
 * Phase 3 keeps it process-local; durable persistence per artifact lands
 * with the audit-log hook. Phase 5 may extend with on-disk JSON (matches
 * `~/.anvil/runs/<runId>/artifacts/<artifactId>.json` per ADR §3).
 */

import type { ReadonlyArtifactStore } from './types.js';

export class InMemoryArtifactStore implements ReadonlyArtifactStore {
  private readonly map = new Map<string, unknown>();

  has(artifactId: string): boolean {
    return this.map.has(artifactId);
  }

  read<T = unknown>(artifactId: string): T | undefined {
    return this.map.get(artifactId) as T | undefined;
  }

  ids(): readonly string[] {
    return Array.from(this.map.keys());
  }

  write(artifactId: string, data: unknown): void {
    this.map.set(artifactId, data);
  }
}
