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
export function createReplay(opts = {}) {
    const maxPerRoom = opts.maxPerRoom ?? 500;
    const maxBytes = opts.maxBytesPerRoom ?? 1_000_000;
    const sizeOf = opts.sizeOf ?? ((ev) => JSON.stringify(ev).length);
    const buf = new Map();
    function getSlot(room) {
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
                while (slot.events.length > maxPerRoom ||
                    (slot.bytes > maxBytes && slot.events.length > 1)) {
                    const evicted = slot.events.shift();
                    if (!evicted)
                        break;
                    slot.bytes -= sizeOf(evicted);
                    if (slot.bytes < 0)
                        slot.bytes = 0;
                }
            }
        },
        since(room, sinceId) {
            const slot = buf.get(room);
            if (!slot)
                return [];
            if (!sinceId)
                return slot.events.slice();
            const idx = slot.events.findIndex((e) => e.id === sinceId);
            if (idx < 0)
                return slot.events.slice();
            return slot.events.slice(idx + 1);
        },
        stats() {
            const perRoom = [];
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
//# sourceMappingURL=replay.js.map