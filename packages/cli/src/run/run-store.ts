// Run store — manages run records on disk

import {
  readFileSync,
  writeFileSync,
  existsSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import type { RunRecord, StageResult } from './types.js';
import { RunDirectory } from './run-directory.js';
import { IndexWriter } from './index-writer.js';

export class RunStore {
  private readonly runsBasePath: string;
  private readonly indexWriter: IndexWriter;

  constructor(runsBasePath: string) {
    this.runsBasePath = runsBasePath;
    this.indexWriter = new IndexWriter(join(runsBasePath, 'index.jsonl'));
  }

  async createRun(record: RunRecord): Promise<void> {
    const runDir = new RunDirectory(
      join(this.runsBasePath, record.project),
      record.id,
    );
    runDir.create();

    // Write run-record.json
    const recordPath = join(runDir.getRunPath(), 'run-record.json');
    writeFileSync(recordPath, JSON.stringify(record, null, 2), 'utf-8');

    // Append to index
    await this.indexWriter.append(record);
  }

  async updateRun(
    runId: string,
    updates: Partial<RunRecord>,
  ): Promise<RunRecord> {
    const record = await this.loadRunFromIndex(runId);
    if (!record) {
      throw new Error(`Run not found: ${runId}`);
    }

    const runDir = new RunDirectory(
      join(this.runsBasePath, record.project),
      runId,
    );
    const recordPath = join(runDir.getRunPath(), 'run-record.json');

    // Backup rotation: current -> bak1, bak1 -> bak2, bak2 -> bak3, bak3 discarded
    this.rotateBackups(recordPath);

    // Merge updates
    const updated: RunRecord = {
      ...record,
      ...updates,
      id: record.id, // never overwrite id
      updatedAt: new Date().toISOString(),
    };

    // Atomic write: .tmp then rename
    const tmpPath = recordPath + '.tmp';
    writeFileSync(tmpPath, JSON.stringify(updated, null, 2), 'utf-8');
    renameSync(tmpPath, recordPath);

    return updated;
  }

  async updateStage(
    runId: string,
    stageIndex: number,
    updates: Partial<StageResult>,
  ): Promise<RunRecord> {
    const record = await this.loadRunFromIndex(runId);
    if (!record) {
      throw new Error(`Run not found: ${runId}`);
    }

    if (stageIndex < 0 || stageIndex >= record.stages.length) {
      throw new Error(`Invalid stage index: ${stageIndex}`);
    }

    const updatedStages = [...record.stages];
    updatedStages[stageIndex] = {
      ...updatedStages[stageIndex],
      ...updates,
    };

    return this.updateRun(runId, { stages: updatedStages });
  }

  async loadRun(runId: string, project: string): Promise<RunRecord | null> {
    const runDir = new RunDirectory(
      join(this.runsBasePath, project),
      runId,
    );
    const recordPath = join(runDir.getRunPath(), 'run-record.json');

    if (!existsSync(recordPath)) {
      return null;
    }

    const content = readFileSync(recordPath, 'utf-8');
    return JSON.parse(content) as RunRecord;
  }

  private async loadRunFromIndex(runId: string): Promise<RunRecord | null> {
    // Try to find it in the index first
    const indexPath = join(this.runsBasePath, 'index.jsonl');
    if (!existsSync(indexPath)) {
      return null;
    }

    const content = readFileSync(indexPath, 'utf-8');
    const lines = content.split('\n').filter((l) => l.trim());

    for (const line of lines) {
      try {
        const record = JSON.parse(line) as RunRecord;
        if (record.id === runId) {
          // Load fresh from disk
          return this.loadRun(runId, record.project);
        }
      } catch {
        continue;
      }
    }

    return null;
  }

  private rotateBackups(recordPath: string): void {
    const bak3 = recordPath + '.bak3';
    const bak2 = recordPath + '.bak2';
    const bak1 = recordPath + '.bak1';

    // Discard bak3
    try {
      if (existsSync(bak3)) unlinkSync(bak3);
    } catch { /* ignore */ }

    // bak2 -> bak3
    try {
      if (existsSync(bak2)) renameSync(bak2, bak3);
    } catch { /* ignore */ }

    // bak1 -> bak2
    try {
      if (existsSync(bak1)) renameSync(bak1, bak2);
    } catch { /* ignore */ }

    // current -> bak1
    try {
      if (existsSync(recordPath)) renameSync(recordPath, bak1);
    } catch { /* ignore */ }
  }
}
