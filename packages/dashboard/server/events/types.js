/**
 * Typed event union for the dashboard WS surface.
 *
 * Today's wire format is `{ type: string; payload: unknown }` — fully
 * untyped. This module is the v2 contract: every emission has a stable
 * `kind`, a typed `payload`, an id-ordered envelope, and a topic set.
 *
 * Phase 2 introduces the types but doesn't switch the wire over —
 * `broadcast()` keeps emitting the legacy shape. Phase 3 tranches replace
 * call sites with `services.<X>.emit(kind, payload)` which the
 * service-bridge translates into both wire shapes (legacy + new). Phase 4
 * deletes the legacy adapter once socket.io owns the wire.
 *
 * Topics are socket.io rooms — see `topics.ts` for the
 * `roomsForEvent(ev)` mapping.
 */
// ── Id generation ────────────────────────────────────────────────────────
let _seq = 0;
/**
 * Generate a monotonically increasing event id `<ts>-<seq>`. The id is
 * ordered by emission time; replay queries use it as a cursor.
 *
 * Test seam: pass a fixed `now` for deterministic snapshots.
 */
export function nextEventId(now = Date.now) {
    return `${now()}-${(++_seq).toString(36)}`;
}
/**
 * Build an event envelope. Callers (services) emit by kind+payload;
 * the bridge wraps the payload into an envelope before queuing for
 * the wire layer.
 */
export function envelope(kind, payload, topics, now = Date.now) {
    return {
        id: nextEventId(now),
        kind,
        payload,
        ts: now(),
        topics,
        schemaVersion: 1,
    };
}
//# sourceMappingURL=types.js.map