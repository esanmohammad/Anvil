/**
 * SnapshotManager — keep last N checkpoint snapshots, rotate on each write.
 */

import { existsSync, mkdirSync, readdirSync, unlinkSync, copyFileSync } from 'node:fs';
import { join, basename } from 'node:path';

export interface SnapshotManagerConfig {
  /** Directory to store snapshots. */
  snapshotDir: string;
  /** Maximum number of snapshots to retain. Default 3. */
  maxSnapshots: number;
}

export class SnapshotManager {
  private config: SnapshotManagerConfig;

  constructor(config: SnapshotManagerConfig) {
    this.config = {
      snapshotDir: config.snapshotDir,
      maxSnapshots: config.maxSnapshots ?? 3,
    };
    mkdirSync(this.config.snapshotDir, { recursive: true });
  }

  /**
   * Create a snapshot of the given file.
   * Copies the file into the snapshot directory with a timestamp suffix.
   * Rotates old snapshots if max is exceeded.
   */
  createSnapshot(sourceFile: string): string {
    if (!existsSync(sourceFile)) {
      throw new Error(`Source file does not exist: ${sourceFile}`);
    }

    const ts = Date.now();
    const name = `${basename(sourceFile)}.${ts}`;
    const dest = join(this.config.snapshotDir, name);
    copyFileSync(sourceFile, dest);

    this.rotate(basename(sourceFile));
    return dest;
  }

  /** List existing snapshots for a given base filename, newest first. */
  listSnapshots(baseFilename: string): string[] {
    if (!existsSync(this.config.snapshotDir)) return [];
    const files = readdirSync(this.config.snapshotDir)
      .filter((f) => f.startsWith(baseFilename + '.'))
      .sort()
      .reverse();
    return files.map((f) => join(this.config.snapshotDir, f));
  }

  /** Get the latest snapshot path for a base filename. */
  getLatestSnapshot(baseFilename: string): string | null {
    const snapshots = this.listSnapshots(baseFilename);
    return snapshots.length > 0 ? snapshots[0] : null;
  }

  /** Remove old snapshots beyond maxSnapshots. */
  private rotate(baseFilename: string): void {
    const snapshots = this.listSnapshots(baseFilename);
    const excess = snapshots.slice(this.config.maxSnapshots);
    for (const path of excess) {
      try {
        unlinkSync(path);
      } catch {
        // ignore
      }
    }
  }
}
