/**
 * StructuredLogger — JSON log lines to ~/.anvil/logs/<runId>.jsonl
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  runId: string;
  data?: Record<string, unknown>;
}

export class StructuredLogger {
  private runId: string;
  private logFile: string;
  private minLevel: LogLevel;

  private static readonly LEVEL_ORDER: LogLevel[] = ['debug', 'info', 'warn', 'error'];

  constructor(runId: string, logsDir: string, minLevel: LogLevel = 'info') {
    this.runId = runId;
    this.logFile = join(logsDir, `${runId}.jsonl`);
    this.minLevel = minLevel;
    mkdirSync(dirname(this.logFile), { recursive: true });
  }

  debug(message: string, data?: Record<string, unknown>): void {
    this.log('debug', message, data);
  }

  info(message: string, data?: Record<string, unknown>): void {
    this.log('info', message, data);
  }

  warn(message: string, data?: Record<string, unknown>): void {
    this.log('warn', message, data);
  }

  error(message: string, data?: Record<string, unknown>): void {
    this.log('error', message, data);
  }

  /** Write a log entry if it meets the minimum level. */
  log(level: LogLevel, message: string, data?: Record<string, unknown>): void {
    if (!this.shouldLog(level)) return;
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      runId: this.runId,
      ...(data ? { data } : {}),
    };
    this.writeEntry(entry);
  }

  /** Get the log file path. */
  getLogFile(): string {
    return this.logFile;
  }

  private shouldLog(level: LogLevel): boolean {
    const idx = StructuredLogger.LEVEL_ORDER.indexOf(level);
    const minIdx = StructuredLogger.LEVEL_ORDER.indexOf(this.minLevel);
    return idx >= minIdx;
  }

  private writeEntry(entry: LogEntry): void {
    const line = JSON.stringify(entry) + '\n';
    appendFileSync(this.logFile, line, 'utf-8');
  }
}
