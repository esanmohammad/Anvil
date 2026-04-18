// @ts-ignore — ws is a runtime dependency, types may not be installed
import { WebSocketServer, WebSocket } from 'ws';
import { ChannelManager } from './channels.js';
import type { WSMessage, WSClientMessage, Channel } from './types.js';

export interface WSServerOptions {
  port?: number;
  heartbeatInterval?: number;
  path?: string;
}

export class DashboardWSServer {
  private wss: WebSocketServer | null = null;
  private channels = new ChannelManager();
  private clients = new Map<string, WebSocket>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private clientAlive = new Map<string, boolean>();
  private startTime = Date.now();
  private clientCounter = 0;

  constructor(private options: WSServerOptions = {}) {}

  start(): void {
    const port = this.options.port ?? 3334;
    this.wss = new WebSocketServer({ port, path: this.options.path ?? '/ws' });
    this.startTime = Date.now();

    this.wss.on('connection', (ws: any) => {
      const clientId = `client-${++this.clientCounter}`;
      this.clients.set(clientId, ws);
      this.clientAlive.set(clientId, true);

      ws.on('message', (raw: any) => {
        try {
          const msg: WSClientMessage = JSON.parse(raw.toString());
          this.handleClientMessage(clientId, msg);
        } catch {
          // ignore malformed messages
        }
      });

      ws.on('close', () => {
        this.channels.removeClient(clientId);
        this.clients.delete(clientId);
        this.clientAlive.delete(clientId);
      });

      ws.on('pong', () => {
        this.clientAlive.set(clientId, true);
      });

      // Send welcome
      ws.send(JSON.stringify({
        channel: 'project' as Channel,
        event: 'connected',
        data: { clientId },
        timestamp: Date.now(),
      }));
    });

    // Heartbeat
    const interval = this.options.heartbeatInterval ?? 30000;
    this.heartbeatTimer = setInterval(() => {
      for (const [clientId, ws] of this.clients) {
        if (!this.clientAlive.get(clientId)) {
          ws.terminate();
          this.channels.removeClient(clientId);
          this.clients.delete(clientId);
          this.clientAlive.delete(clientId);
          continue;
        }
        this.clientAlive.set(clientId, false);
        ws.ping();
      }
    }, interval);
  }

  private handleClientMessage(clientId: string, msg: WSClientMessage): void {
    switch (msg.type) {
      case 'subscribe':
        if (msg.channel) {
          this.channels.subscribe(clientId, { channel: msg.channel, filters: msg.filters });
        }
        break;
      case 'unsubscribe':
        if (msg.channel) {
          this.channels.unsubscribe(clientId, msg.channel);
        }
        break;
      case 'pong':
        this.clientAlive.set(clientId, true);
        break;
      case 'action':
        // Emit action event for external handling
        break;
    }
  }

  broadcast(message: WSMessage): void {
    const subscribers = this.channels.getSubscribers(message.channel);
    const payload = JSON.stringify(message);
    for (const clientId of subscribers) {
      const ws = this.clients.get(clientId);
      if (ws && ws.readyState === WebSocket.OPEN) {
        if (this.channels.matchesFilter(message, clientId)) {
          ws.send(payload);
        }
      }
    }
  }

  send(clientId: string, message: WSMessage): void {
    const ws = this.clients.get(clientId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(message));
    }
  }

  getClientCount(): number {
    return this.clients.size;
  }

  getUptime(): number {
    return Date.now() - this.startTime;
  }

  stop(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    for (const ws of this.clients.values()) {
      ws.close();
    }
    this.clients.clear();
    this.wss?.close();
    this.wss = null;
  }
}

export default DashboardWSServer;
