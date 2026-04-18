/**
 * CheckpointIntegrity — validates JSON checkpoints, detects truncation, auto-recovers.
 */

import { readFileSync, existsSync } from 'node:fs';
import { SnapshotManager } from './snapshot-manager.js';

export interface IntegrityResult {
  valid: boolean;
  error?: string;
  recovered: boolean;
  recoveredFrom?: string;
}

export class CheckpointIntegrity {
  private snapshotManager: SnapshotManager | null;

  constructor(snapshotManager?: SnapshotManager) {
    this.snapshotManager = snapshotManager ?? null;
  }

  /** Validate a checkpoint file. Auto-recover from snapshots if invalid. */
  validate(filePath: string): IntegrityResult {
    if (!existsSync(filePath)) {
      return { valid: false, error: 'File does not exist', recovered: false };
    }

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch (err) {
      return {
        valid: false,
        error: `Cannot read file: ${(err as Error).message}`,
        recovered: false,
      };
    }

    // Check for truncation indicators
    const truncationError = this.detectTruncation(content);
    if (truncationError) {
      return this.tryRecover(filePath, truncationError);
    }

    // Try parsing as JSON
    try {
      JSON.parse(content);
      return { valid: true, recovered: false };
    } catch (err) {
      return this.tryRecover(
        filePath,
        `Invalid JSON: ${(err as Error).message}`,
      );
    }
  }

  /** Detect common truncation patterns. */
  private detectTruncation(content: string): string | null {
    if (content.length === 0) {
      return 'File is empty';
    }
    const trimmed = content.trim();
    // JSON should end with } or ] or a quoted string/number/boolean/null
    if (
      trimmed.startsWith('{') &&
      !trimmed.endsWith('}')
    ) {
      return 'JSON object appears truncated (no closing brace)';
    }
    if (
      trimmed.startsWith('[') &&
      !trimmed.endsWith(']')
    ) {
      return 'JSON array appears truncated (no closing bracket)';
    }
    return null;
  }

  /** Attempt recovery from snapshot. */
  private tryRecover(
    filePath: string,
    error: string,
  ): IntegrityResult {
    if (!this.snapshotManager) {
      return { valid: false, error, recovered: false };
    }

    const filename = filePath.split('/').pop() ?? '';
    const snapshot = this.snapshotManager.getLatestSnapshot(filename);
    if (!snapshot) {
      return { valid: false, error, recovered: false };
    }

    // Validate the snapshot itself
    try {
      const snapshotContent = readFileSync(snapshot, 'utf-8');
      JSON.parse(snapshotContent);
      return {
        valid: false,
        error,
        recovered: true,
        recoveredFrom: snapshot,
      };
    } catch {
      return { valid: false, error, recovered: false };
    }
  }
}
