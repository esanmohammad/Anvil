/**
 * Bounded network + console ring buffers for the Tier 2 browser. Each
 * BrowserSession instantiates one of these and the Playwright runner
 * pushes events into them. The agent reads via cursor pagination.
 */
import type { BrowserNetworkRecord, BrowserConsoleMessage } from '@esankhan3/anvil-core-pipeline';
export declare class RingBuffer<T> {
    private readonly cap;
    private buf;
    private nextSeq;
    private droppedTo;
    constructor(cap: number);
    push(item: T): void;
    /** Return items strictly after the given cursor (0 = from start). */
    read(cursor: number, limit: number): {
        items: T[];
        nextCursor: number;
    };
    size(): number;
    clear(): void;
}
export declare class NetworkRecorder {
    readonly buffer: RingBuffer<BrowserNetworkRecord>;
    constructor(cap?: number);
    record(req: BrowserNetworkRecord): void;
    query(args: {
        urlPattern?: string;
        status?: number;
        method?: string;
        failed?: boolean;
        cursor?: string;
        limit?: number;
    }): {
        requests: BrowserNetworkRecord[];
        nextCursor?: string;
    };
}
export declare class ConsoleRecorder {
    readonly buffer: RingBuffer<BrowserConsoleMessage>;
    constructor(cap?: number);
    record(msg: BrowserConsoleMessage): void;
    query(args: {
        level?: string;
        cursor?: string;
        limit?: number;
    }): {
        messages: BrowserConsoleMessage[];
        nextCursor?: string;
    };
}
//# sourceMappingURL=network-recorder.d.ts.map