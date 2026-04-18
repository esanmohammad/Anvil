import { useState, useEffect, useRef, useCallback } from 'react';
import type { OutputChunk } from '../../server/types.js';

export interface UseOutputStreamOptions {
  subscribe: (channel: string, filters?: Record<string, string>) => void;
  unsubscribe: (channel: string) => void;
  lastMessage: unknown | null;
  maxChunks?: number;
}

export function useOutputStream({ subscribe, unsubscribe, lastMessage, maxChunks = 2000 }: UseOutputStreamOptions) {
  const [chunks, setChunks] = useState<OutputChunk[]>([]);
  const [activeRepo, setActiveRepo] = useState<string | null>(null);
  const [activeStage, setActiveStage] = useState<string | null>(null);
  const subscribedRef = useRef(false);

  useEffect(() => {
    if (!subscribedRef.current) {
      subscribe('output');
      subscribedRef.current = true;
    }
    return () => {
      unsubscribe('output');
      subscribedRef.current = false;
    };
  }, [subscribe, unsubscribe]);

  useEffect(() => {
    const msg = lastMessage as { channel?: string; data?: OutputChunk } | null;
    if (msg?.channel === 'output' && msg.data) {
      setChunks((prev) => [...prev, msg.data!].slice(-maxChunks));
    }
  }, [lastMessage, maxChunks]);

  const filteredChunks = chunks.filter((chunk) => {
    if (activeRepo && chunk.repo !== activeRepo) return false;
    if (activeStage && chunk.stage !== activeStage) return false;
    return true;
  });

  const clear = useCallback(() => setChunks([]), []);

  return {
    chunks: filteredChunks,
    allChunks: chunks,
    activeRepo,
    setActiveRepo,
    activeStage,
    setActiveStage,
    clear,
  };
}

export default useOutputStream;
