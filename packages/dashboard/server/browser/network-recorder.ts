/**
 * Bounded network + console ring buffers for the Tier 2 browser. Each
 * BrowserSession instantiates one of these and the Playwright runner
 * pushes events into them. The agent reads via cursor pagination.
 */

import type { BrowserNetworkRecord, BrowserConsoleMessage } from '@esankhan3/anvil-core-pipeline';

const DEFAULT_NETWORK_CAP = 500;
const DEFAULT_CONSOLE_CAP = 500;

export class RingBuffer<T> {
  private buf: T[] = [];
  private nextSeq = 0;
  private droppedTo = 0;

  constructor(private readonly cap: number) {}

  push(item: T): void {
    this.buf.push(item);
    this.nextSeq += 1;
    if (this.buf.length > this.cap) {
      const overflow = this.buf.length - this.cap;
      this.buf.splice(0, overflow);
      this.droppedTo += overflow;
    }
  }

  /** Return items strictly after the given cursor (0 = from start). */
  read(cursor: number, limit: number): { items: T[]; nextCursor: number } {
    const startSeq = Math.max(cursor, this.droppedTo);
    const startIdx = startSeq - this.droppedTo;
    if (startIdx >= this.buf.length) {
      return { items: [], nextCursor: this.nextSeq };
    }
    const slice = this.buf.slice(startIdx, startIdx + limit);
    const nextCursor = startSeq + slice.length;
    return { items: slice, nextCursor };
  }

  size(): number {
    return this.buf.length;
  }

  clear(): void {
    this.buf = [];
    this.droppedTo = this.nextSeq;
  }
}

export class NetworkRecorder {
  readonly buffer: RingBuffer<BrowserNetworkRecord>;

  constructor(cap = DEFAULT_NETWORK_CAP) {
    this.buffer = new RingBuffer<BrowserNetworkRecord>(cap);
  }

  record(req: BrowserNetworkRecord): void {
    this.buffer.push(req);
  }

  query(args: {
    urlPattern?: string; status?: number; method?: string; failed?: boolean;
    cursor?: string; limit?: number;
  }): { requests: BrowserNetworkRecord[]; nextCursor?: string } {
    const cursor = args.cursor ? parseInt(args.cursor, 10) || 0 : 0;
    const limit = Math.min(args.limit ?? 50, 500);
    const { items, nextCursor } = this.buffer.read(cursor, limit);
    const filtered = items.filter((r) => {
      if (args.urlPattern && !globMatch(r.url, args.urlPattern)) return false;
      if (args.status !== undefined && r.status !== args.status) return false;
      if (args.method && r.method.toUpperCase() !== args.method.toUpperCase()) return false;
      if (args.failed !== undefined && r.failed !== args.failed) return false;
      return true;
    });
    return { requests: filtered, nextCursor: String(nextCursor) };
  }
}

export class ConsoleRecorder {
  readonly buffer: RingBuffer<BrowserConsoleMessage>;

  constructor(cap = DEFAULT_CONSOLE_CAP) {
    this.buffer = new RingBuffer<BrowserConsoleMessage>(cap);
  }

  record(msg: BrowserConsoleMessage): void {
    this.buffer.push(msg);
  }

  query(args: {
    level?: string; cursor?: string; limit?: number;
  }): { messages: BrowserConsoleMessage[]; nextCursor?: string } {
    const cursor = args.cursor ? parseInt(args.cursor, 10) || 0 : 0;
    const limit = Math.min(args.limit ?? 100, 500);
    const { items, nextCursor } = this.buffer.read(cursor, limit);
    const filtered = items.filter((m) => !args.level || m.level === args.level);
    return { messages: filtered, nextCursor: String(nextCursor) };
  }
}

function globMatch(s: string, pattern: string): boolean {
  // Minimal glob: `*` matches any chars, anchored as substring.
  const re = new RegExp(
    pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*'),
  );
  return re.test(s);
}
