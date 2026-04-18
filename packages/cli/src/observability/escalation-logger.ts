/**
 * EscalationLogger — record escalation events to a JSON file (append-only).
 */

import { readFileSync, appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface EscalationLogEntry {
  timestamp: string;
  eventId: string;
  level: string;
  previousLevel: string | null;
  stageName: string;
  reason: string;
  failureCount: number;
  resolved: boolean;
}

export class EscalationLogger {
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    mkdirSync(dirname(filePath), { recursive: true });
  }

  /** Append an escalation event to the log file. */
  logEvent(entry: EscalationLogEntry): void {
    const line = JSON.stringify(entry) + '\n';
    appendFileSync(this.filePath, line, 'utf-8');
  }

  /** Read all logged escalation events. */
  readEvents(): EscalationLogEntry[] {
    if (!existsSync(this.filePath)) return [];
    try {
      const content = readFileSync(this.filePath, 'utf-8');
      return content
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as EscalationLogEntry);
    } catch {
      return [];
    }
  }

  /** Get the log file path. */
  getFilePath(): string {
    return this.filePath;
  }
}
