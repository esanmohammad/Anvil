/**
 * IncompleteCheckpointDetector — detect stale locks, missing end markers, offer rollback.
 */

import { existsSync, readFileSync, unlinkSync, statSync } from 'node:fs';

export interface IncompleteCheckpoint {
  path: string;
  issue: 'stale-lock' | 'missing-end-marker' | 'in-progress';
  lockAge?: number; // ms since lock creation
  description: string;
}

export interface IncompleteCheckpointConfig {
  /** Max age of a lock file before it's considered stale (ms). Default 10 min. */
  staleLockThresholdMs: number;
  /** End marker property in JSON to verify completion. Default '__completed'. */
  endMarkerKey: string;
}

const DEFAULT_CONFIG: IncompleteCheckpointConfig = {
  staleLockThresholdMs: 10 * 60_000,
  endMarkerKey: '__completed',
};

export class IncompleteCheckpointDetector {
  private config: IncompleteCheckpointConfig;

  constructor(config?: Partial<IncompleteCheckpointConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Detect issues with a checkpoint file and its associated lock. */
  detect(checkpointPath: string): IncompleteCheckpoint | null {
    const lockPath = checkpointPath + '.lock';

    // Check for stale lock files
    if (existsSync(lockPath)) {
      try {
        const stat = statSync(lockPath);
        const lockAge = Date.now() - stat.mtimeMs;
        if (lockAge >= this.config.staleLockThresholdMs) {
          return {
            path: checkpointPath,
            issue: 'stale-lock',
            lockAge,
            description: `Lock file is ${Math.round(lockAge / 1000)}s old (threshold: ${Math.round(this.config.staleLockThresholdMs / 1000)}s)`,
          };
        } else {
          return {
            path: checkpointPath,
            issue: 'in-progress',
            lockAge,
            description: 'Checkpoint write is in progress',
          };
        }
      } catch {
        // Cannot stat lock, skip
      }
    }

    // Check for missing end marker in JSON
    if (existsSync(checkpointPath)) {
      try {
        const content = readFileSync(checkpointPath, 'utf-8');
        const data = JSON.parse(content);
        if (typeof data === 'object' && data !== null && !data[this.config.endMarkerKey]) {
          return {
            path: checkpointPath,
            issue: 'missing-end-marker',
            description: `Checkpoint is missing the '${this.config.endMarkerKey}' marker`,
          };
        }
      } catch {
        // If JSON is invalid, CheckpointIntegrity handles that
      }
    }

    return null;
  }

  /** Remove a stale lock file. Returns true if removed. */
  rollbackLock(checkpointPath: string): boolean {
    const lockPath = checkpointPath + '.lock';
    if (existsSync(lockPath)) {
      try {
        unlinkSync(lockPath);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
}
