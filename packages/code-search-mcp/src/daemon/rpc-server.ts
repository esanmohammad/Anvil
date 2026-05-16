/**
 * Daemon-side UDS JSON-RPC server. Speaks the methods declared by the
 * daemon-client backend. Strict 1.0 contract — adding methods requires both
 * sides to bump in lockstep.
 */

import { createServer, type Server, type Socket } from 'node:net';
import { existsSync, unlinkSync, mkdirSync } from 'node:fs';
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
  id?: number;
  method: keyof RpcHandlers;
  params: unknown;
}

export class RpcServer extends EventEmitter {
  private readonly socketPath: string;
  private readonly handlers: RpcHandlers;
  private server: Server | null = null;
  private readonly clients = new Set<Socket>();

  constructor(opts: { socketPath: string; handlers: RpcHandlers }) {
    super();
    this.socketPath = opts.socketPath;
    this.handlers = opts.handlers;
  }

  async start(): Promise<void> {
    if (process.platform !== 'win32' && existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch { /* ignore */ }
    }
    mkdirSync(dirname(this.socketPath), { recursive: true });

    await new Promise<void>((resolveP, rejectP) => {
      this.server = createServer((sock) => this.handleClient(sock));
      this.server.on('error', (err) => {
        this.emit('error', err);
        rejectP(err);
      });
      this.server.listen(this.socketPath, () => {
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
      await new Promise<void>((r) => this.server!.close(() => r()));
      this.server = null;
    }
    if (process.platform !== 'win32' && existsSync(this.socketPath)) {
      try { unlinkSync(this.socketPath); } catch { /* ignore */ }
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
    const handler = this.handlers[req.method];
    if (!handler) {
      sock.write(this.errorEnvelope(req.id ?? null, -32601, `Method not found: ${req.method}`));
      return;
    }
    try {
      const result = await handler(req.params as never);
      sock.write(JSON.stringify({ jsonrpc: '2.0', id: req.id ?? null, result }) + '\n');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sock.write(this.errorEnvelope(req.id ?? null, -32000, msg));
    }
  }

  private errorEnvelope(id: number | null, code: number, message: string): string {
    return JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n';
  }
}
