// JSONL index writer for run records

import { writeFileSync, appendFileSync, existsSync, unlinkSync } from 'node:fs';
import { dirname } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { RunRecord } from './types.js';

export class IndexWriter {
  private readonly indexPath: string;

  constructor(indexPath: string) {
    this.indexPath = indexPath;
  }

  async append(record: RunRecord): Promise<void> {
    const dir = dirname(this.indexPath);
    mkdirSync(dir, { recursive: true });

    const line = JSON.stringify(record) + '\n';
    const tmpPath = this.indexPath + '.tmp';

    // Write to tmp first for atomicity
    writeFileSync(tmpPath, line, 'utf-8');

    // Append tmp contents to main file
    appendFileSync(this.indexPath, line, 'utf-8');

    // Clean up tmp
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore cleanup errors
    }
  }
}
