/**
 * Thin wrapper around a WebSocket connection to the Anvil dashboard server.
 *
 * The dashboard speaks a simple JSON protocol: the client sends `{ action, ... }`
 * and the server broadcasts `{ type, payload }` messages. This helper lets the
 * CLI send one action and wait for a set of response `type`s, optionally
 * streaming intermediate messages (like `agent-output` entries) via a handler.
 *
 * Usage:
 *   const client = await connectDashboard();
 *   const result = await client.request(
 *     { action: 'get-plan', project, planSlug },
 *     { resolveOn: ['plan'], rejectOn: ['error'], onMessage: (m) => ... },
 *   );
 *   client.close();
 */
import WebSocket from 'ws';

export interface DashboardWsOptions {
  /** Port the dashboard is serving on. Default 5173 (matches `anvil dashboard`). */
  port?: number;
  /** Host to connect to. Default 'localhost'. */
  host?: string;
  /** Connection timeout in ms. Default 3000. */
  timeoutMs?: number;
}

export interface DashboardMessage {
  type: string;
  payload?: unknown;
}

export interface RequestOptions {
  /** Message types that should resolve the request. */
  resolveOn: string[];
  /** Message types that should reject the request. Defaults to `['error']`. */
  rejectOn?: string[];
  /** Called for EVERY message received, including resolve/reject. */
  onMessage?: (msg: DashboardMessage) => void;
  /**
   * Optional filter — only count a `resolveOn` match if this returns true.
   * Useful when multiple plan messages might flow over the same socket
   * and we need the one for a specific slug.
   */
  filter?: (msg: DashboardMessage) => boolean;
  /** Overall request timeout in ms. Default 120_000 (2 min). */
  timeoutMs?: number;
}

export class DashboardClient {
  constructor(
    private ws: WebSocket,
    public readonly url: string,
  ) {}

  /**
   * Send an action and wait for one of the `resolveOn` response types.
   * All other messages are streamed to `onMessage` until resolution.
   */
  request<T = unknown>(action: Record<string, unknown>, opts: RequestOptions): Promise<{ type: string; payload: T }> {
    const rejectOn = opts.rejectOn ?? ['error'];
    const timeoutMs = opts.timeoutMs ?? 120_000;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`Dashboard request timed out after ${timeoutMs}ms (action=${String(action.action)})`));
      }, timeoutMs);

      const onData = (data: WebSocket.RawData) => {
        let msg: DashboardMessage;
        try {
          msg = JSON.parse(data.toString()) as DashboardMessage;
        } catch {
          return;
        }
        if (!msg || typeof msg.type !== 'string') return;

        try { opts.onMessage?.(msg); } catch { /* user handler errors are not fatal */ }

        const matched = opts.filter ? opts.filter(msg) : true;
        if (!matched) return;

        if (opts.resolveOn.includes(msg.type)) {
          cleanup();
          resolve({ type: msg.type, payload: msg.payload as T });
        } else if (rejectOn.includes(msg.type)) {
          cleanup();
          const payload = msg.payload as { message?: string } | undefined;
          reject(new Error(payload?.message ?? `Server returned ${msg.type}`));
        }
      };

      const onClose = () => {
        cleanup();
        reject(new Error('Dashboard WebSocket closed before response arrived.'));
      };

      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };

      const cleanup = () => {
        clearTimeout(timer);
        this.ws.off('message', onData);
        this.ws.off('close', onClose);
        this.ws.off('error', onError);
      };

      this.ws.on('message', onData);
      this.ws.on('close', onClose);
      this.ws.on('error', onError);

      this.ws.send(JSON.stringify(action));
    });
  }

  close(): void {
    try { this.ws.close(); } catch { /* ignore */ }
  }
}

/**
 * Connect to a running dashboard server. Throws a user-facing error if the
 * server isn't reachable — the CLI surfaces the message directly.
 */
export async function connectDashboard(opts: DashboardWsOptions = {}): Promise<DashboardClient> {
  const port = opts.port ?? 5173;
  const host = opts.host ?? 'localhost';
  const url = `ws://${host}:${port}`;
  const timeoutMs = opts.timeoutMs ?? 3000;

  return await new Promise<DashboardClient>((resolve, reject) => {
    const ws = new WebSocket(url);
    const timer = setTimeout(() => {
      try { ws.terminate(); } catch { /* ignore */ }
      reject(new Error(
        `Dashboard not reachable at ${url}. Run \`anvil dashboard\` in another terminal (or pass --port if it's on a different port).`,
      ));
    }, timeoutMs);

    ws.once('open', () => {
      clearTimeout(timer);
      resolve(new DashboardClient(ws, url));
    });

    ws.once('error', (err) => {
      clearTimeout(timer);
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ECONNREFUSED') {
        reject(new Error(
          `Dashboard not reachable at ${url}. Run \`anvil dashboard\` in another terminal (or pass --port if it's on a different port).`,
        ));
      } else {
        reject(err);
      }
    });
  });
}
