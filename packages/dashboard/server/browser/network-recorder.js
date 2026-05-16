/**
 * Bounded network + console ring buffers for the Tier 2 browser. Each
 * BrowserSession instantiates one of these and the Playwright runner
 * pushes events into them. The agent reads via cursor pagination.
 */
const DEFAULT_NETWORK_CAP = 500;
const DEFAULT_CONSOLE_CAP = 500;
export class RingBuffer {
    cap;
    buf = [];
    nextSeq = 0;
    droppedTo = 0;
    constructor(cap) {
        this.cap = cap;
    }
    push(item) {
        this.buf.push(item);
        this.nextSeq += 1;
        if (this.buf.length > this.cap) {
            const overflow = this.buf.length - this.cap;
            this.buf.splice(0, overflow);
            this.droppedTo += overflow;
        }
    }
    /** Return items strictly after the given cursor (0 = from start). */
    read(cursor, limit) {
        const startSeq = Math.max(cursor, this.droppedTo);
        const startIdx = startSeq - this.droppedTo;
        if (startIdx >= this.buf.length) {
            return { items: [], nextCursor: this.nextSeq };
        }
        const slice = this.buf.slice(startIdx, startIdx + limit);
        const nextCursor = startSeq + slice.length;
        return { items: slice, nextCursor };
    }
    size() {
        return this.buf.length;
    }
    clear() {
        this.buf = [];
        this.droppedTo = this.nextSeq;
    }
}
export class NetworkRecorder {
    buffer;
    constructor(cap = DEFAULT_NETWORK_CAP) {
        this.buffer = new RingBuffer(cap);
    }
    record(req) {
        this.buffer.push(req);
    }
    query(args) {
        const cursor = args.cursor ? parseInt(args.cursor, 10) || 0 : 0;
        const limit = Math.min(args.limit ?? 50, 500);
        const { items, nextCursor } = this.buffer.read(cursor, limit);
        const filtered = items.filter((r) => {
            if (args.urlPattern && !globMatch(r.url, args.urlPattern))
                return false;
            if (args.status !== undefined && r.status !== args.status)
                return false;
            if (args.method && r.method.toUpperCase() !== args.method.toUpperCase())
                return false;
            if (args.failed !== undefined && r.failed !== args.failed)
                return false;
            return true;
        });
        return { requests: filtered, nextCursor: String(nextCursor) };
    }
}
export class ConsoleRecorder {
    buffer;
    constructor(cap = DEFAULT_CONSOLE_CAP) {
        this.buffer = new RingBuffer(cap);
    }
    record(msg) {
        this.buffer.push(msg);
    }
    query(args) {
        const cursor = args.cursor ? parseInt(args.cursor, 10) || 0 : 0;
        const limit = Math.min(args.limit ?? 100, 500);
        const { items, nextCursor } = this.buffer.read(cursor, limit);
        const filtered = items.filter((m) => !args.level || m.level === args.level);
        return { messages: filtered, nextCursor: String(nextCursor) };
    }
}
function globMatch(s, pattern) {
    // Minimal glob: `*` matches any chars, anchored as substring.
    const re = new RegExp(pattern.split('*').map((p) => p.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*'));
    return re.test(s);
}
//# sourceMappingURL=network-recorder.js.map