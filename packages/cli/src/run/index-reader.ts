// JSONL index reader for run records

import { createReadStream, existsSync } from 'node:fs';
import { createInterface } from 'node:readline';
import type { RunRecord, RunStatus } from './types.js';

export interface RunFilter {
  project?: string;
  status?: RunStatus;
  limit?: number;
}

export class IndexReader {
  private readonly indexPath: string;

  constructor(indexPath: string) {
    this.indexPath = indexPath;
  }

  async listRuns(filter?: RunFilter): Promise<RunRecord[]> {
    const records = await this.readAll();

    let filtered = records;

    if (filter?.project) {
      filtered = filtered.filter((r) => r.project === filter.project);
    }
    if (filter?.status) {
      filtered = filtered.filter((r) => r.status === filter.status);
    }

    // Sort by createdAt descending
    filtered.sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    if (filter?.limit !== undefined && filter.limit > 0) {
      filtered = filtered.slice(0, filter.limit);
    }

    return filtered;
  }

  async findRun(id: string): Promise<RunRecord | null> {
    const records = await this.readAll();
    return records.find((r) => r.id === id) ?? null;
  }

  async findBySystem(project: string): Promise<RunRecord[]> {
    return this.listRuns({ project });
  }

  async findByStatus(status: RunStatus): Promise<RunRecord[]> {
    return this.listRuns({ status });
  }

  private async readAll(): Promise<RunRecord[]> {
    if (!existsSync(this.indexPath)) {
      return [];
    }

    const records: RunRecord[] = [];
    const stream = createReadStream(this.indexPath, { encoding: 'utf-8' });
    const rl = createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed) as RunRecord);
      } catch {
        // Skip corrupted lines but warn
        console.warn(`Skipping corrupted line in index: ${trimmed.slice(0, 80)}...`);
      }
    }

    return records;
  }
}
