import type { Channel, WSMessage, ClientSubscription } from './types.js';

/** Manages channel subscriptions and message routing */
export class ChannelManager {
  private subscriptions = new Map<string, Set<Channel>>();
  private filters = new Map<string, Map<Channel, Record<string, string>>>();

  subscribe(clientId: string, sub: ClientSubscription): void {
    if (!this.subscriptions.has(clientId)) {
      this.subscriptions.set(clientId, new Set());
      this.filters.set(clientId, new Map());
    }
    this.subscriptions.get(clientId)!.add(sub.channel);
    if (sub.filters) {
      this.filters.get(clientId)!.set(sub.channel, sub.filters);
    }
  }

  unsubscribe(clientId: string, channel: Channel): void {
    this.subscriptions.get(clientId)?.delete(channel);
    this.filters.get(clientId)?.delete(channel);
  }

  removeClient(clientId: string): void {
    this.subscriptions.delete(clientId);
    this.filters.delete(clientId);
  }

  getSubscribers(channel: Channel): string[] {
    const result: string[] = [];
    for (const [clientId, channels] of this.subscriptions) {
      if (channels.has(channel)) {
        result.push(clientId);
      }
    }
    return result;
  }

  isSubscribed(clientId: string, channel: Channel): boolean {
    return this.subscriptions.get(clientId)?.has(channel) ?? false;
  }

  getFilters(clientId: string, channel: Channel): Record<string, string> | undefined {
    return this.filters.get(clientId)?.get(channel);
  }

  matchesFilter(message: WSMessage, clientId: string): boolean {
    const filters = this.getFilters(clientId, message.channel);
    if (!filters) return true;
    const data = message.data as Record<string, unknown>;
    for (const [key, value] of Object.entries(filters)) {
      if (data && data[key] !== value) return false;
    }
    return true;
  }

  getClientChannels(clientId: string): Channel[] {
    return Array.from(this.subscriptions.get(clientId) ?? []);
  }
}
