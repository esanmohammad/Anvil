// JSONL output logger for agent output.
// Writes to ~/.anvil/runs/<project>/<runId>/output.jsonl

import { appendFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

export interface OutputLogEntry {
  timestamp: number;
  stage: string;
  type: 'stdout' | 'stderr';
  content: string;
}

/** Append a single output entry to the JSONL log file. */
export function appendOutput(logPath: string, entry: OutputLogEntry): void {
  const dir = dirname(logPath);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  appendFileSync(logPath, JSON.stringify(entry) + '\n', 'utf-8');
}
