/**
 * useDashboardSocket — typed WS hook backed by the Phase 4–6 socket.io
 * transport + Phase 5 typed reducer.
 *
 * Connects to the dashboard via socket.io-client (when `ANVIL_SOCKET_IO=1`
 * env was set at server start) and falls back to a raw `WebSocket` to
 * `/ws` otherwise. Both paths feed the same legacy `{type,payload}`
 * messages through `wireToEvent(...)` → `dashboardReducer`.
 *
 * Frontend usage:
 *
 *   function App() {
 *     const { state, send, subscribe, unsubscribe, ready } = useDashboardSocket();
 *     // state is a typed DashboardUiState; send dispatches client actions.
 *   }
 *
 * Per-route components add topic subscriptions inside `useEffect`:
 *
 *   useEffect(() => {
 *     subscribe([`run:${runId}`]);
 *     return () => unsubscribe([`run:${runId}`]);
 *   }, [runId]);
 *
 * Topic semantics:
 *   - Every client auto-joins `'global'` on connect (lossless transition
 *     from today's firehose).
 *   - Per-entity rooms — `run:<id>`, `project:<slug>`, `plan:<slug>`,
 *     `review:<id>`, `test-spec:<slug>`, `cost`, `kb`, `incident` —
 *     scope per-page subscriptions.
 *
 * Compared to the legacy `useWebSocket` hook + ad-hoc `new WebSocket`
 * in `main.tsx:408`, this hook owns:
 *   1. Connection lifecycle (reconnect with exponential backoff).
 *   2. Typed message → reducer dispatch via `wireToEvent`.
 *   3. Topic subscribe/unsubscribe with `since` cursor for backfill.
 *   4. Outbound action helper (`send(actionName, args)`).
 */

import { useEffect, useReducer, useRef, useState, type MutableRefObject } from 'react';
import { io as socketIoConnect, type Socket as SocketIoClient } from 'socket.io-client';
import {
  dashboardReducer,
  initialUiState,
  wireToEvent,
  type DashboardUiState,
} from '../state/reducer.js';
import type { Topic } from '../../shared/events.js';
import { WebSocketCompat } from './ws-compat-proxy.js';

// ── Public API ───────────────────────────────────────────────────────────

export type ReadyState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

export interface DashboardSocket {
  state: DashboardUiState;
  ready: ReadyState;
  /** Send a client action (`run-pipeline`, `stop-run`, …). */
  send: (action: string, args?: Record<string, unknown>) => void;
  /** Join one or more topic rooms; optional `since` cursor for backfill. */
  subscribe: (rooms: Topic[], since?: Partial<Record<Topic, string>>) => void;
  /** Leave one or more topic rooms. */
  unsubscribe: (rooms: Topic[]) => void;
  /** True if socket.io transport is active (false → raw-WS legacy path). */
  isSocketIo: boolean;
}

export interface UseDashboardSocketOpts {
  /** Override the URL. Default: window.location origin. */
  url?: string;
  /** Max reconnect attempts before giving up. Default: 10. */
  maxRetries?: number;
  /**
   * Optional escape-hatch: invoked for every incoming wire message BEFORE
   * the reducer dispatch. Lets the legacy `handleServerMessage` switch in
   * `main.tsx` keep populating its imperative setState pipeline while the
   * reducer runs in parallel. Will be removed once the reducer owns all
   * UI state.
   */
  onWire?: (wire: { type: string; payload: unknown }) => void;
  /**
   * Optional ref the hook writes a `WebSocketCompat` proxy into so
   * pre-migration child components consuming `ws.send(JSON.stringify(…))`
   * keep working unchanged. The hook sets it to null on disconnect.
   */
  wsRef?: MutableRefObject<WebSocket | null>;
  /**
   * Optional retry counter — exposed so the legacy reconnect-banner in
   * `main.tsx` can mirror its old "attempt N/M" UX. The hook writes the
   * current attempt count here on each reconnect.
   */
  retriesRef?: MutableRefObject<number>;
}

// ── Implementation ───────────────────────────────────────────────────────

const SOCKET_IO_PATH = '/socket.io';

/**
 * Returns the base URL. Browser: `window.location.origin`. Tests: pass
 * `opts.url` explicitly.
 */
function defaultBaseUrl(): string {
  if (typeof window === 'undefined') return 'http://localhost:5173';
  return window.location.origin;
}

export function useDashboardSocket(opts: UseDashboardSocketOpts = {}): DashboardSocket {
  const [state, dispatch] = useReducer(dashboardReducer, initialUiState);
  const [ready, setReady] = useState<ReadyState>('connecting');
  // `isSocketIo` always true after Phase 8 (raw WS deleted); kept on the
  // return type as a stable boolean.
  const isSocketIo = true;

  const socketIoRef = useRef<SocketIoClient | null>(null);
  const retriesRef = useRef(0);

  const baseUrl = opts.url ?? defaultBaseUrl();
  const maxRetries = opts.maxRetries ?? 10;

  // ── Wire-level dispatch ────────────────────────────────────────────
  // Convert every incoming `{type, payload}` to a typed event and feed
  // the reducer. Unknown types fall through silently — historically
  // `init` and `error` aren't in the DashboardEvent union and the UI
  // handles them via component-local effects.
  function handleWire(wire: { type: string; payload: unknown }): void {
    // Phase 7 migration: call legacy handler first so its imperative setState
    // pipeline stays the source of truth until the reducer fully replaces it.
    if (opts.onWire) {
      try { opts.onWire(wire); } catch { /* swallow — onWire is best-effort */ }
    }
    const ev = wireToEvent(wire);
    if (ev) dispatch(ev);
  }

  // ── Socket.io connect (the only transport after Phase 8) ──────────
  function connectSocketIo(): void {
    const sock = socketIoConnect(baseUrl, {
      path: SOCKET_IO_PATH,
      // websocket-only — the dashboard's static handler 404s on
      // `/socket.io/*` HTTP requests, so engine.io's polling transport
      // can't complete its long-poll handshake.
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: maxRetries,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 30_000,
      forceNew: true,
    });
    socketIoRef.current = sock;

    // Expose a WS-shaped facade so child components consuming the
    // `ws` prop keep working without per-component refactors.
    const compat = new WebSocketCompat(sock) as unknown as WebSocket;
    if (opts.wsRef) opts.wsRef.current = compat;

    sock.on('connect', () => {
      setReady('connected');
      retriesRef.current = 0;
      if (opts.retriesRef) opts.retriesRef.current = 0;
      // Re-request current state on (re)connect — the server's `onAction`
      // adapter routes this to `handleClientMessage` which fires
      // `sendInit` and emits the `init` frame.
      sock.emit('action', { action: 'get-state' });
    });
    sock.on('disconnect', () => {
      setReady('disconnected');
      if (opts.wsRef) opts.wsRef.current = null;
    });
    sock.on('reconnect_attempt', () => setReady('reconnecting'));

    // `onAny` captures every server emission; the legacy slug stays as
    // the wire vocabulary so `wireToEvent` can map it to a typed kind.
    sock.onAny((type: string, payload: unknown) => handleWire({ type, payload }));
  }

  // ── Connect on mount ───────────────────────────────────────────────
  useEffect(() => {
    connectSocketIo();
    return () => {
      try { socketIoRef.current?.disconnect(); } catch { /* ok */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Outbound API ───────────────────────────────────────────────────
  const send = (action: string, args?: Record<string, unknown>): void => {
    const msg = { action, ...(args ?? {}) };
    socketIoRef.current?.emit('action', msg);
  };

  const subscribe = (rooms: Topic[], since?: Partial<Record<Topic, string>>): void => {
    socketIoRef.current?.emit('subscribe', { rooms, since });
  };

  const unsubscribe = (rooms: Topic[]): void => {
    socketIoRef.current?.emit('unsubscribe', { rooms });
  };

  return { state, ready, send, subscribe, unsubscribe, isSocketIo };
}

export default useDashboardSocket;
