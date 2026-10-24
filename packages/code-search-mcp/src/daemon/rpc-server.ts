/**
 * Daemon-side UDS JSON-RPC server. Speaks the methods declared by the
 * daemon-client backend. Strict 1.0 contract — adding methods requires both
 * sides to bump in lockstep.
 *
 * JSON-RPC 2.0 subset: one request object per line; only the handlers' own
 * method names dispatch; notifications (no `id`) run without a reply; batch
 * arrays are answered with a single "not supported" error.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { mkdirSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { EventEmitter } from 'node:events';

export interface RpcMethod<Params, Result> {
  (params: Params): Promise<Result> | Result;
}

export interface RpcHandlers {
  'search.code': RpcMethod<{ query: string; mode: string; maxResults?: number; repos?: string[] }, unknown>;
  'index.status': RpcMethod<Record<string, never>, unknown>;
  'index.force': RpcMethod<{ force?: boolean }, unknown>;
  'index.invalidate': RpcMethod<{ paths: string[] }, { ok: true }>;
  'health': RpcMethod<Record<string, never>, { ok: true; uptime: number }>;
}

interface JsonRpcRequest {
  jsonrpc: '2.0';
  id?: number | string | null;
  method: keyof RpcHandlers;
  params: unknown;
}

export class RpcServer extends EventEmitter {
  private readonly socketPath: string;
  private readonly handlers: RpcHandlers;
  private server: Server | null = null;
  private readonly clients = new Set<Socket>();
  /** Inode of the socket file this server created — stop() unlinks only that. */
  private socketIno: number | null = null;

  constructor(opts: { socketPath: string; handlers: RpcHandlers }) {
    super();
    this.socketPath = opts.socketPath;
    this.handlers = opts.handlers;
  }

  /** Listen on the socket. An existing socket file is NOT removed — the
   *  caller decides whether it is stale; listening then fails EADDRINUSE. */
  async start(): Promise<void> {
    mkdirSync(dirname(this.socketPath), { recursive: true });

    await new Promise<void>((resolveP, rejectP) => {
      this.server = createServer((sock) => this.handleClient(sock));
      this.server.on('error', (err) => {
        this.emit('error', err);
        rejectP(err);
      });
      this.server.listen(this.socketPath, () => {
        if (process.platform !== 'win32') {
          try { this.socketIno = statSync(this.socketPath).ino; } catch { /* unlinked already */ }
        }
        this.emit('listening', this.socketPath);
        resolveP();
      });
    });
  }

  async stop(): Promise<void> {
    for (const c of this.clients) {
      try { c.destroy(); } catch { /* ignore */ }
    }
    this.clients.clear();
    if (this.server) {
      if (process.platform === 'win32' || this.ownsSocketFile()) {
        // Closing a UDS server also unlinks its path (libuv).
        await new Promise<void>((r) => this.server!.close(() => r()));
      } else {
        // The path now belongs to another process — closing would unlink
        // THEIR socket. Leave the handle to process exit.
        this.server.unref();
      }
      this.server = null;
    }
    this.socketIno = null;
  }

  private ownsSocketFile(): boolean {
    try {
      return this.socketIno !== null && statSync(this.socketPath).ino === this.socketIno;
    } catch {
      return false;
    }
  }

  private handleClient(sock: Socket): void {
    this.clients.add(sock);
    let buf = '';
    sock.setNoDelay(true);
    sock.on('end', () => this.clients.delete(sock));
    sock.on('error', () => this.clients.delete(sock));
    sock.on('data', async (chunk) => {
      buf += chunk.toString('utf-8');
      let idx = buf.indexOf('\n');
      while (idx >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        await this.handleLine(sock, line);
        idx = buf.indexOf('\n');
      }
    });
  }

  private async handleLine(sock: Socket, line: string): Promise<void> {
    if (!line.trim()) return;
    let req: JsonRpcRequest;
    try {
      req = JSON.parse(line);
    } catch (err) {
      sock.write(this.errorEnvelope(null, -32700, err instanceof Error ? err.message : String(err)));
      return;
    }
    if (Array.isArray(req)) {
      sock.write(this.errorEnvelope(null, -32600, 'Batch requests are not supported'));
      return;
    }
    if (typeof req !== 'object' || req === null || typeof req.method !== 'string') {
      sock.write(this.errorEnvelope(null, -32600, 'Invalid request'));
      return;
    }
    // A request without an `id` member is a notification: never answered.
    const isNotification = !Object.prototype.hasOwnProperty.call(req, 'id');
    const id = req.id ?? null;
    const handler = Object.prototype.hasOwnProperty.call(this.handlers, req.method)
      ? this.handlers[req.method]
      : undefined;
    if (typeof handler !== 'function') {
      if (!isNotification) sock.write(this.errorEnvelope(id, -32601, `Method not found: ${req.method}`));
      return;
    }
    try {
      const result = await (handler as RpcMethod<unknown, unknown>)(req.params);
      if (!isNotification) sock.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isNotification) sock.write(this.errorEnvelope(id, -32000, msg));
    }
  }

  private errorEnvelope(id: number | string | null, code: number, message: string): string {
    return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n';
  }
}
