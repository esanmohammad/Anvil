/**
 * Agent Process Manager — real-time output stream parser.
 */

import type { AgentEvent } from './types.js';

export class StreamParser {
  private buffer = '';

  /**
   * Feed a raw chunk into the parser.
   * Returns an array of AgentEvent objects — one per complete line.
   */
  parse(chunk: string): AgentEvent[] {
    this.buffer += chunk;
    const events: AgentEvent[] = [];
    const lines = this.buffer.split('\n');

    // The last element is either empty (line ended with \n) or a partial line.
    this.buffer = lines.pop() ?? '';

    for (const line of lines) {
      events.push(this.parseLine(line));
    }
    return events;
  }

  /**
   * Flush any remaining buffered data as events.
   */
  flush(): AgentEvent[] {
    if (this.buffer.length === 0) return [];
    const events = [this.parseLine(this.buffer)];
    this.buffer = '';
    return events;
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private parseLine(line: string): AgentEvent {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      return { type: 'output', data: line };
    }

    // Attempt JSON parse — structured tool calls, etc.
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        return { type: 'output', data: JSON.stringify(parsed) };
      } catch {
        // Not valid JSON — fall through to raw text.
      }
    }

    return { type: 'output', data: line };
  }
}
