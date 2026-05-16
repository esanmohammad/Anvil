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
  perRoom: Array<{ room: Topic; count: number; bytes: number }>;
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

interface Slot {
  events: DashboardEvent[];
  bytes: number;
}

export interface ReplayOpts {
  /** Max events per room before drop-oldest kicks in. Default 500. */
  maxPerRoom?: number;
  /** Max bytes per room before drop-oldest kicks in. Default 1 MiB. */
  maxBytesPerRoom?: number;
  /** Test seam — JSON byte sizer. Default: `JSON.stringify(ev).length`. */
  sizeOf?: (ev: DashboardEvent) => number;
}

export function createReplay(opts: ReplayOpts = {}): EventReplay {
  const maxPerRoom = opts.maxPerRoom ?? 500;
  const maxBytes = opts.maxBytesPerRoom ?? 1_000_000;
  const sizeOf = opts.sizeOf ?? ((ev) => JSON.stringify(ev).length);
  const buf = new Map<Topic, Slot>();

  function getSlot(room: Topic): Slot {
    let slot = buf.get(room);
    if (!slot) {
      slot = { events: [], bytes: 0 };
      buf.set(room, slot);
    }
    return slot;
  }

  return {
    append(ev) {
      const evBytes = sizeOf(ev);
      for (const room of ev.topics) {
        const slot = getSlot(room);
        slot.events.push(ev);
        slot.bytes += evBytes;
        // Drop oldest until under both caps. Per-event size is computed
        // once; we recompute on eviction via the stored sizeOf so
        // accounting stays consistent if the test seam returns
        // a different size for the same event later.
        while (
          slot.events.length > maxPerRoom ||
          (slot.bytes > maxBytes && slot.events.length > 1)
        ) {
          const evicted = slot.events.shift();
          if (!evicted) break;
          slot.bytes -= sizeOf(evicted);
          if (slot.bytes < 0) slot.bytes = 0;
        }
      }
    },

    since(room, sinceId) {
      const slot = buf.get(room);
      if (!slot) return [];
      if (!sinceId) return slot.events.slice();
      const idx = slot.events.findIndex((e) => e.id === sinceId);
      if (idx < 0) return slot.events.slice();
      return slot.events.slice(idx + 1);
    },

    stats() {
      const perRoom: ReplayStats['perRoom'] = [];
      let totalEvents = 0;
      let totalBytes = 0;
      for (const [room, slot] of buf.entries()) {
        perRoom.push({ room, count: slot.events.length, bytes: slot.bytes });
        totalEvents += slot.events.length;
        totalBytes += slot.bytes;
      }
      return { rooms: buf.size, totalEvents, totalBytes, perRoom };
    },

    clear() {
      buf.clear();
    },
  };
}
