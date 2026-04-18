import { useState, useEffect, useRef, useCallback } from 'react';
import type { ActivityEntry } from '../../server/types.js';

export interface ActivityFilter {
  level?: string;
  source?: string;
  repo?: string;
  search?: string;
}

export interface UseActivityFeedOptions {
  subscribe: (channel: string, filters?: Record<string, string>) => void;
  unsubscribe: (channel: string) => void;
  lastMessage: unknown | null;
  maxEntries?: number;
}

export function useActivityFeed({ subscribe, unsubscribe, lastMessage, maxEntries = 500 }: UseActivityFeedOptions) {
  const [entries, setEntries] = useState<ActivityEntry[]>([]);
  const [filter, setFilter] = useState<ActivityFilter>({});
  const subscribedRef = useRef(false);

  useEffect(() => {
    if (!subscribedRef.current) {
      subscribe('activity');
      subscribedRef.current = true;
    }
    return () => {
      unsubscribe('activity');
      subscribedRef.current = false;
    };
  }, [subscribe, unsubscribe]);

  useEffect(() => {
    const msg = lastMessage as { channel?: string; data?: ActivityEntry } | null;
    if (msg?.channel === 'activity' && msg.data) {
      setEntries((prev) => [msg.data!, ...prev].slice(0, maxEntries));
    }
  }, [lastMessage, maxEntries]);

  const filteredEntries = entries.filter((entry) => {
    if (filter.level && entry.level !== filter.level) return false;
    if (filter.source && entry.source !== filter.source) return false;
    if (filter.repo && entry.repo !== filter.repo) return false;
    if (filter.search && !entry.message.toLowerCase().includes(filter.search.toLowerCase())) return false;
    return true;
  });

  const clear = useCallback(() => setEntries([]), []);

  return { entries: filteredEntries, allEntries: entries, filter, setFilter, clear };
}

export default useActivityFeed;
