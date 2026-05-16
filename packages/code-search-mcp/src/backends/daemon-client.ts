/**
 * Daemon-backed SearchBackend — proxies all calls to the local
 * code-search-daemon over UDS (or named pipe on Windows) via a minimal
 * JSON-RPC 2.0 client. One connection per call; the daemon side keeps state.
 */

import { createConnection, type Socket } from 'node:net';
import { existsSync } from 'node:fs';
import type {
  BackendConfig,
  IndexStatusPayload,
  SearchBackend,
  SearchOpts,
  SearchResultPayload,
} from './types.js';

interface JsonRpcResponse<T> {
  jsonrpc: '2.0';
  id: number;
  result?: T;
  error?: { code: number; message: string };
}

let nextRpcId = 1;

export class DaemonBackend implements SearchBackend {
  readonly kind = 'daemon' as const;
  readonly project: string;
  private readonly socketPath: string;
  private readonly startedAt = Date.now();

  constructor(cfg: BackendConfig & { socketPath: string }) {
    this.project = cfg.project;
    this.socketPath = cfg.socketPath;
  }

  async search(query: string, opts: SearchOpts): Promise<SearchResultPayload> {
    return this.rpc<SearchResultPayload>('search.code', { query, ...opts });
  }

  async status(): Promise<IndexStatusPayload> {
    return this.rpc<IndexStatusPayload>('index.status', {});
  }

  async forceIndex(opts?: { force?: boolean }): Promise<IndexStatusPayload> {
    return this.rpc<IndexStatusPayload>('index.force', { force: opts?.force ?? false });
  }

  async invalidate(paths: string[]): Promise<void> {
    await this.rpc<{ ok: true }>('index.invalidate', { paths });
  }

  async close(): Promise<void> {
    // Connections are per-request; nothing to release.
  }

  /** Ping the daemon to check liveness. Returns true on success within ~100ms. */
  async ping(): Promise<boolean> {
    try {
      const r = await this.rpc<{ ok: boolean }>('health', {}, 250);
      return !!r.ok;
    } catch {
      return false;
    }
  }

  private rpc<T>(method: string, params: unknown, timeoutMs = 30_000): Promise<T> {
    return new Promise((resolveP, rejectP) => {
      if (!existsSync(this.socketPath)) {
        rejectP(new Error(`daemon socket not found at ${this.socketPath}`));
        return;
      }
      const id = nextRpcId++;
      let buf = '';
      let settled = false;
      const sock: Socket = createConnection(this.socketPath);

      const finish = (err: Error | null, value?: T): void => {
        if (settled) return;
        settled = true;
        sock.destroy();
        clearTimeout(timer);
        if (err) rejectP(err);
        else resolveP(value as T);
      };

      const timer = setTimeout(() => finish(new Error(`daemon RPC timeout: ${method}`)), timeoutMs);

      sock.setNoDelay(true);
      sock.on('error', (err) => finish(err));
      sock.on('data', (chunk) => {
        buf += chunk.toString('utf-8');
        let idx = buf.indexOf('\n');
        while (idx >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          try {
            const msg = JSON.parse(line) as JsonRpcResponse<T>;
            if (msg.id !== id) {
              idx = buf.indexOf('\n');
              continue;
            }
            if (msg.error) finish(new Error(`daemon RPC error ${msg.error.code}: ${msg.error.message}`));
            else finish(null, msg.result);
            return;
          } catch (err) {
            finish(err instanceof Error ? err : new Error(String(err)));
            return;
          }
        }
      });
      sock.on('connect', () => {
        const req = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
        sock.write(req);
      });
    });
  }
}
