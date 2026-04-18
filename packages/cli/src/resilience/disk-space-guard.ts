/**
 * DiskSpaceGuard — check available disk space, warn/error at thresholds.
 */

import { statfsSync } from 'node:fs';

export interface DiskSpaceStatus {
  availableBytes: number;
  availableMB: number;
  availableGB: number;
  level: 'ok' | 'warning' | 'critical';
  message: string;
}

export interface DiskSpaceConfig {
  /** Warning threshold in bytes. Default 1GB. */
  warnThresholdBytes: number;
  /** Error threshold in bytes. Default 200MB. */
  errorThresholdBytes: number;
}

const ONE_GB = 1024 * 1024 * 1024;
const ONE_MB = 1024 * 1024;

const DEFAULT_CONFIG: DiskSpaceConfig = {
  warnThresholdBytes: ONE_GB,
  errorThresholdBytes: 200 * ONE_MB,
};

export class DiskSpaceGuard {
  private config: DiskSpaceConfig;

  constructor(config?: Partial<DiskSpaceConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /** Check disk space at the given path. */
  check(path: string): DiskSpaceStatus {
    let availableBytes: number;
    try {
      const stats = statfsSync(path);
      availableBytes = stats.bavail * stats.bsize;
    } catch {
      // If statfs fails, return unknown (assume ok)
      return {
        availableBytes: -1,
        availableMB: -1,
        availableGB: -1,
        level: 'ok',
        message: 'Unable to determine disk space',
      };
    }

    const availableMB = Math.round(availableBytes / ONE_MB);
    const availableGB = Math.round((availableBytes / ONE_GB) * 100) / 100;

    let level: DiskSpaceStatus['level'] = 'ok';
    let message = `${availableGB} GB available`;

    if (availableBytes < this.config.errorThresholdBytes) {
      level = 'critical';
      message = `Critical: only ${availableMB} MB available (< ${Math.round(this.config.errorThresholdBytes / ONE_MB)} MB)`;
    } else if (availableBytes < this.config.warnThresholdBytes) {
      level = 'warning';
      message = `Warning: only ${availableGB} GB available (< ${Math.round(this.config.warnThresholdBytes / ONE_GB)} GB)`;
    }

    return { availableBytes, availableMB, availableGB, level, message };
  }

  /** Quick check returning true if space is sufficient. */
  hasSufficientSpace(path: string): boolean {
    const status = this.check(path);
    return status.level !== 'critical';
  }
}
