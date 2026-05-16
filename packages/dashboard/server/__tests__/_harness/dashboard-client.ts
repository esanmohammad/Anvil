/**
 * DashboardClient — protocol abstraction for the test harness.
 *
 * Scenarios speak to this interface; they never reach for the underlying
 * socket directly. After Phase 8 there is only one implementation
 * (socket.io); the abstraction stays as the seam for future transport
 * changes.
 */

import { io as socketIoConnect, type Socket as SocketIoClient } from 'socket.io-client';

/** Anything received over the wire. Today this is the legacy `{type,payload}` shape. */
export interface WireMessage {
  type: string;
  payload: unknown;
}

export interface ClientAction {
  action: string;
  [k: string]: unknown;
}

export interface CollectOpts {
  /** Stop collecting when this returns true for an incoming message. */
  until: (msg: WireMessage) => boolean;
  /** Throws if `until` doesn't match within this window. */
  timeoutMs: number;
}

export interface DashboardClient {
  /** Send a client action. */
  send(msg: ClientAction): void;
  /**
   * Join one or more topic rooms (socket.io only — raw-WS is firehose).
   * `since` is per-room cursor for backfill on reconnect; optional.
   */
  subscribe(rooms: string[], since?: Record<string, string>): void;
  /** Leave one or more topic rooms (socket.io only). */
  unsubscribe(rooms: string[]): void;
  /** Wait until `until` matches; resolves with all messages observed inclusive of the matcher. */
  collect(opts: CollectOpts): Promise<WireMessage[]>;
  /** Convenience: wait for a single message of a given type. */
  waitFor(type: string, timeoutMs: number): Promise<WireMessage>;
  /** Drain any queued messages without waiting. */
  drain(): WireMessage[];
  close(): Promise<void>;
}

/**
 * socket.io impl. Mirrors `rawWsClient` so scenario tests use either
 * transport unchanged. Phase 4 mounts socket.io alongside raw-WS so
 * the harness flips to this without modifying any scenario.
 *
 * The wire shape: today's bridge emits each event as
 * `io.to(rooms).emit(legacyType, payload)`. So `socket.on('agent-output', payload => ...)`
 * receives the payload directly. We adapt to the WireMessage `{type, payload}`
 * shape by listening to onAny.
 */
export async function socketIoClient(url: string, opts?: { origin?: string }): Promise<DashboardClient> {
  return new Promise((resolve, reject) => {
    // Node socket.io-client sends no Origin header by default; the dashboard's
    // CORS allowlist rejects undefined Origin. Supply one explicitly that
    // matches the bound port. Tests usually pass the http://localhost:<port>
    // URL → derive Origin from that.
    const origin = opts?.origin ?? new URL(url).origin;
    const sock: SocketIoClient = socketIoConnect(url, {
      path: '/socket.io',
      // websocket-only: the dashboard's static handler 404s on
      // `/socket.io/*` HTTP requests because socket.io is mounted via
      // upgrade-dispatch only (no `attach(server)`), so the polling
      // transport's GET/POST round-trips would fall through to the
      // static handler. Direct WS upgrade works because our dispatcher
      // routes `/socket.io/*` upgrades to engine.io.
      transports: ['websocket'],
      reconnection: false,
      forceNew: true,
      extraHeaders: { Origin: origin },
    });

    const buffer: WireMessage[] = [];
    const waiters: Array<(m: WireMessage) => void> = [];

    sock.onAny((type: string, payload: unknown) => {
      const msg: WireMessage = { type, payload };
      const next = waiters[0];
      if (next) next(msg);
      else buffer.push(msg);
    });

    const collect = async ({ until, timeoutMs }: CollectOpts): Promise<WireMessage[]> => {
      const collected: WireMessage[] = [];
      while (buffer.length > 0) {
        const m = buffer.shift()!;
        collected.push(m);
        if (until(m)) return collected;
      }
      return new Promise<WireMessage[]>((res, rej) => {
        const onMsg = (m: WireMessage) => {
          collected.push(m);
          if (until(m)) {
            clearTimeout(timer);
            const idx = waiters.indexOf(onMsg);
            if (idx >= 0) waiters.splice(idx, 1);
            res(collected);
          }
        };
        const timer = setTimeout(() => {
          const idx = waiters.indexOf(onMsg);
          if (idx >= 0) waiters.splice(idx, 1);
          rej(new Error(
            `collect() timed out after ${timeoutMs}ms.\n` +
              `Collected ${collected.length} message(s): ` +
              collected.map((m) => m.type).join(', '),
          ));
        }, timeoutMs);
        waiters.push(onMsg);
      });
    };

    const client: DashboardClient = {
      send(msg: ClientAction) {
        // Server's onAction handler routes the message into the existing
        // handleClientMessage switch via a fauxWs adapter; replies come
        // back as socket.io events caught by the onAny listener above.
        sock.emit('action', msg);
      },
      subscribe(rooms: string[], since?: Record<string, string>) {
        sock.emit('subscribe', { rooms, since });
      },
      unsubscribe(rooms: string[]) {
        sock.emit('unsubscribe', { rooms });
      },
      collect,
      async waitFor(type: string, timeoutMs: number): Promise<WireMessage> {
        const events = await collect({
          until: (m) => m.type === type,
          timeoutMs,
        });
        return events[events.length - 1];
      },
      drain(): WireMessage[] {
        return buffer.splice(0);
      },
      async close(): Promise<void> {
        sock.disconnect();
      },
    };

    sock.on('connect', () => resolve(client));
    sock.on('connect_error', (err) => reject(err));
  });
}
