// Pipeline audit log — structured JSONL logging for every pipeline event

import { existsSync, mkdirSync, appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAnvilDirs } from '../home.js';

export type AuditEvent =
  | 'stage-start'
  | 'stage-complete'
  | 'stage-fail'
  | 'tool-use'
  | 'file-write'
  | 'file-read'
  | 'cost-incurred'
  | 'approval-requested'
  | 'approval-granted'
  | 'pipeline-start'
  | 'pipeline-complete'
  | 'pipeline-fail';

export interface AuditEntry {
  timestamp: string;
  runId: string;
  stage: string;
  event: AuditEvent;
  details: Record<string, unknown>;
}

export class AuditLog {
  private logPath: string;
  private logDir: string;

  constructor(runId: string) {
    const dirs = getAnvilDirs();
    this.logDir = join(dirs.runs, runId);
    this.logPath = join(this.logDir, 'audit.jsonl');
  }

  private ensureDir(): void {
    if (!existsSync(this.logDir)) {
      mkdirSync(this.logDir, { recursive: true });
    }
  }

  append(entry: Omit<AuditEntry, 'timestamp'>): void {
    this.ensureDir();
    const full: AuditEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };
    try {
      appendFileSync(this.logPath, JSON.stringify(full) + '\n', 'utf-8');
    } catch {
      // Best-effort logging — never fail the pipeline
    }
  }

  stageStart(runId: string, stage: string, details?: Record<string, unknown>): void {
    this.append({ runId, stage, event: 'stage-start', details: details ?? {} });
  }

  stageComplete(runId: string, stage: string, cost?: number, duration?: number): void {
    this.append({ runId, stage, event: 'stage-complete', details: { cost, duration } });
  }

  stageFail(runId: string, stage: string, error: string): void {
    this.append({ runId, stage, event: 'stage-fail', details: { error } });
  }

  costIncurred(runId: string, stage: string, inputTokens: number, outputTokens: number, cost: number): void {
    this.append({ runId, stage, event: 'cost-incurred', details: { inputTokens, outputTokens, cost } });
  }

  pipelineStart(runId: string, project: string, feature: string): void {
    this.append({ runId, stage: 'pipeline', event: 'pipeline-start', details: { project, feature } });
  }

  pipelineComplete(runId: string, totalCost: number, prUrls: string[]): void {
    this.append({ runId, stage: 'pipeline', event: 'pipeline-complete', details: { totalCost, prUrls } });
  }

  pipelineFail(runId: string, error: string, failedStage: string): void {
    this.append({ runId, stage: 'pipeline', event: 'pipeline-fail', details: { error, failedStage } });
  }

  getEntries(): AuditEntry[] {
    if (!existsSync(this.logPath)) return [];
    try {
      const raw = readFileSync(this.logPath, 'utf-8');
      return raw
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as AuditEntry);
    } catch {
      return [];
    }
  }

  export(format: 'json' | 'csv'): string {
    const entries = this.getEntries();
    if (format === 'json') {
      return JSON.stringify(entries, null, 2);
    }

    // CSV
    const headers = ['timestamp', 'runId', 'stage', 'event', 'details'];
    const rows = entries.map((e) => [
      e.timestamp,
      e.runId,
      e.stage,
      e.event,
      JSON.stringify(e.details),
    ]);
    return [headers.join(','), ...rows.map((r) => r.map((c) => `"${c}"`).join(','))].join('\n');
  }
}
