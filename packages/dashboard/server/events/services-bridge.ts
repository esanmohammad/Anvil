/**
 * Service → socket.io room bridge.
 *
 * The canonical fan-out path after Phase 8 (raw-WS deletion). For every
 * service emission this bridge:
 *   1. Builds a typed envelope (id, ts, topics).
 *   2. Appends it to the replay ring buffer (backfill on reconnect).
 *   3. Translates to the legacy `<verb>-<noun>` slug via
 *      `wire-translate.ts` and emits to the relevant socket.io rooms.
 *
 * The legacy slug stays as the wire vocabulary so the frontend reducer's
 * `wireToEvent` adapter keeps working unchanged; a future cleanup pass
 * can flip both sides to typed kind names.
 */

import type { Server as SocketIoServer } from 'socket.io';
import type { DashboardServices } from '../services/index.js';
import type { EventReplay } from './replay.js';
import type { DashboardEvent, EventKind, Topic } from './types.js';
import { roomsForEvent } from './topics.js';
import { toLegacyWire } from './wire-translate.js';

export interface ServicesBridgeOpts {
  services: DashboardServices;
  io: SocketIoServer;
  replay: EventReplay;
  now?: () => number;
}

function buildEnvelope<K extends EventKind>(
  kind: K,
  payload: unknown,
  now: () => number,
): DashboardEvent {
  const seed = { kind, payload } as unknown as DashboardEvent;
  const topics: Topic[] = roomsForEvent(seed);
  return {
    id: `${now()}-${Math.random().toString(36).slice(2, 6)}`,
    kind,
    payload,
    ts: now(),
    topics,
    schemaVersion: 1,
  } as DashboardEvent;
}

/**
 * Attach the socket.io bridge. Returns a detach fn so tests + shutdown
 * paths can unwire it cleanly.
 */
export function bridgeServicesToRooms(opts: ServicesBridgeOpts): () => void {
  const { services, io, replay } = opts;
  const now = opts.now ?? Date.now;

  const unsubs: Array<() => void> = [];

  function bind<S extends { onAny: (h: (kind: any, payload: any) => void) => () => void }>(svc: S): void {
    const off = svc.onAny((kind: EventKind, payload: any) => {
      let ev: DashboardEvent;
      try {
        ev = buildEnvelope(kind, payload, now);
      } catch (err) {
        console.warn('[services-bridge] envelope build failed:', err);
        return;
      }
      try {
        replay.append(ev);
      } catch (err) {
        console.warn('[services-bridge] replay.append failed:', err);
      }
      // Emit using the LEGACY wire type (e.g. 'active-runs', 'agent-output')
      // so the frontend reducer doesn't have to change vocabulary at the
      // same moment as the transport. Phase 5 swaps to typed kind names.
      try {
        const legacy = toLegacyWire(ev);
        if (legacy) io.to(ev.topics as string[]).emit(legacy.type, legacy.payload);
      } catch (err) {
        console.warn('[services-bridge] socket.io emit failed:', err);
      }
    });
    unsubs.push(off);
  }

  bind(services.runs);
  bind(services.agents);
  bind(services.pipeline);
  bind(services.reviews);
  bind(services.plans);
  bind(services.tests);
  bind(services.bind);
  bind(services.incidents);
  bind(services.kb);
  bind(services.cost);
  bind(services.projectGraph);
  bind(services.system);

  return () => {
    for (const u of unsubs) { try { u(); } catch { /* ok */ } }
  };
}
