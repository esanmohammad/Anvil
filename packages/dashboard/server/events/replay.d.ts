/**
 * Per-room ring buffer for event replay on (re)subscribe.
 *
 * When a client (re)connects and sends `subscribe { rooms, since }`,
 * the gateway queries this store for events on those rooms with id
 * greater than `since`. Events arrive in emission order; replay
 * flushes BEFORE the client starts receiving live events.
 *
 * Eviction is drop-oldest, bounded by BOTH event count AND byte size
 * per room — whichever hits first. This bounds memory regardless of
 * event volume (high-rate stream of small events) or shape (rare but
 * large incident payloads).
 *
 * Phase 2 ships the store. Phase 4 wires it to the socket.io gateway
 * and adds the subscribe-with-since handshake.
 */
import type { DashboardEvent, Topic } from './types.js';
export interface ReplayStats {
    rooms: number;
    totalEvents: number;
    totalBytes: number;
    perRoom: Array<{
        room: Topic;
        count: number;
        bytes: number;
    }>;
}
export interface EventReplay {
    /** Append an event to every room in `ev.topics`. */
    append(ev: DashboardEvent): void;
    /** Return events on `room` with id > `sinceId`, in emission order. */
    since(room: Topic, sinceId?: string): DashboardEvent[];
    /** Diagnostics — used by tests + the gateway's status endpoint. */
    stats(): ReplayStats;
    /** Drop everything; used in tests for clean teardown. */
    clear(): void;
}
export interface ReplayOpts {
    /** Max events per room before drop-oldest kicks in. Default 500. */
    maxPerRoom?: number;
    /** Max bytes per room before drop-oldest kicks in. Default 1 MiB. */
    maxBytesPerRoom?: number;
    /** Test seam — JSON byte sizer. Default: `JSON.stringify(ev).length`. */
    sizeOf?: (ev: DashboardEvent) => number;
}
export declare function createReplay(opts?: ReplayOpts): EventReplay;
//# sourceMappingURL=replay.d.ts.map