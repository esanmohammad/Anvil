/**
 * WebSocketCompat — a WS-shaped facade around socket.io-client.
 *
 * 29 components in the dashboard consume a raw `WebSocket` instance via
 * a `ws` prop and call `ws.send(JSON.stringify(...))`, set `ws.onmessage`,
 * read `ws.readyState`, etc. Migrating each to the new socket.io API is
 * 29 separate refactors. This proxy lets us flip the transport without
 * touching child code — they get an object that looks like a `WebSocket`
 * but actually proxies to the underlying socket.io `Socket`.
 *
 * Supported WebSocket surface (anything child components actually use):
 *   - `send(data: string | ArrayBuffer)` → parses JSON, emits `'action'`
 *   - `readyState: number` → 1 (OPEN) when socket connected, 3 (CLOSED) otherwise
 *   - `close()` → disconnects underlying socket.io socket
 *   - `addEventListener('message', handler)` / `removeEventListener(...)`
 *   - `onmessage = (event) => …`
 *   - `onclose = (event) => …`
 *
 * Server-side counterpart: `dashboard-server.ts` registers
 * `socket.on('action', msg => handleClientMessage(fauxWs, msg))` and
 * replies via `socket.emit(type, payload)`. The hook's `socket.onAny`
 * picks every emit up and forwards it to all `message` listeners on this
 * proxy as a synthetic `MessageEvent { data: JSON.stringify({type,payload}) }`.
 */

import type { Socket as SocketIoClient } from 'socket.io-client';

export const WS_READY_OPEN = 1;
export const WS_READY_CLOSED = 3;

type MessageListener = (event: { data: string }) => void;
type CloseListener = (event: { code?: number; reason?: string }) => void;

export class WebSocketCompat {
  readonly OPEN = WS_READY_OPEN;
  readonly CLOSED = WS_READY_CLOSED;

  onmessage: MessageListener | null = null;
  onclose: CloseListener | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onopen: (() => void) | null = null;

  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  private boundOnAny: ((type: string, payload: unknown) => void) | null = null;

  constructor(private socket: SocketIoClient) {
    // socket.io's `onAny` fires for every server emission. We reshape each
    // emission to look like a raw-WS frame `{type, payload}` and dispatch
    // to all listeners — both the `onmessage` setter and any
    // `addEventListener('message', ...)` registrations.
    this.boundOnAny = (type: string, payload: unknown) => {
      // Drop socket.io internal events that clients aren't expected to see.
      if (type === 'connect' || type === 'disconnect' || type === 'connect_error') return;
      const data = JSON.stringify({ type, payload });
      try { this.onmessage?.({ data }); } catch { /* swallow handler errors */ }
      const messageListeners = this.listeners.get('message');
      if (messageListeners) {
        for (const fn of messageListeners) {
          try { (fn as MessageListener)({ data }); } catch { /* swallow */ }
        }
      }
    };
    socket.onAny(this.boundOnAny);

    socket.on('disconnect', (reason: string) => {
      try { this.onclose?.({ code: 1006, reason }); } catch { /* ok */ }
      const closeListeners = this.listeners.get('close');
      if (closeListeners) {
        for (const fn of closeListeners) {
          try { (fn as CloseListener)({ code: 1006, reason }); } catch { /* ok */ }
        }
      }
    });
  }

  get readyState(): number {
    return this.socket.connected ? this.OPEN : this.CLOSED;
  }

  send(data: string | ArrayBuffer): void {
    if (typeof data !== 'string') {
      console.warn('[ws-compat] binary frames are not supported');
      return;
    }
    let msg: unknown;
    try { msg = JSON.parse(data); } catch { return; }
    this.socket.emit('action', msg);
  }

  close(_code?: number, _reason?: string): void {
    try { this.socket.disconnect(); } catch { /* ok */ }
  }

  addEventListener(type: string, listener: (...args: unknown[]) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (...args: unknown[]) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  /** Detach from the underlying socket.io socket — called when the proxy is replaced. */
  detach(): void {
    if (this.boundOnAny) {
      try { this.socket.offAny(this.boundOnAny); } catch { /* ok */ }
      this.boundOnAny = null;
    }
    this.listeners.clear();
    this.onmessage = null;
    this.onclose = null;
    this.onerror = null;
    this.onopen = null;
  }
}
