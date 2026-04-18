import { useState, useCallback, useEffect, useRef } from 'react';
import type { PipelineUpdate } from '../../server/types.js';

export interface UsePipelineUpdatesOptions {
  subscribe: (channel: string, filters?: Record<string, string>) => void;
  unsubscribe: (channel: string) => void;
  lastMessage: unknown | null;
  project?: string;
}

export function usePipelineUpdates({ subscribe, unsubscribe, lastMessage, project }: UsePipelineUpdatesOptions) {
  const [pipeline, setPipeline] = useState<PipelineUpdate | null>(null);
  const [history, setHistory] = useState<PipelineUpdate[]>([]);
  const subscribedRef = useRef(false);

  useEffect(() => {
    if (!subscribedRef.current) {
      const filters = project ? { project } : undefined;
      subscribe('pipeline', filters);
      subscribedRef.current = true;
    }
    return () => {
      unsubscribe('pipeline');
      subscribedRef.current = false;
    };
  }, [subscribe, unsubscribe, project]);

  useEffect(() => {
    const msg = lastMessage as { channel?: string; event?: string; data?: PipelineUpdate } | null;
    if (msg?.channel === 'pipeline' && msg.data) {
      setPipeline(msg.data);
      if (msg.event === 'completed' || msg.event === 'failed') {
        setHistory((prev) => [msg.data!, ...prev].slice(0, 50));
      }
    }
  }, [lastMessage]);

  const reset = useCallback(() => {
    setPipeline(null);
  }, []);

  return { pipeline, history, reset };
}

export default usePipelineUpdates;
