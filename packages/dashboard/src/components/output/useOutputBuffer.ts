import { useState, useCallback, useRef } from 'react';
import type { OutputChunk } from '../../../server/types.js';

export interface UseOutputBufferOptions {
  maxLines?: number;
}

export function useOutputBuffer({ maxLines = 5000 }: UseOutputBufferOptions = {}) {
  const [lines, setLines] = useState<OutputChunk[]>([]);
  const [autoScroll, setAutoScroll] = useState(true);
  const bufferRef = useRef<OutputChunk[]>([]);

  const append = useCallback((chunk: OutputChunk) => {
    bufferRef.current.push(chunk);
    if (bufferRef.current.length > maxLines) {
      bufferRef.current = bufferRef.current.slice(-maxLines);
    }
    setLines([...bufferRef.current]);
  }, [maxLines]);

  const clear = useCallback(() => {
    bufferRef.current = [];
    setLines([]);
  }, []);

  const search = useCallback((query: string): OutputChunk[] => {
    if (!query) return [];
    const lower = query.toLowerCase();
    return bufferRef.current.filter((c) => c.content.toLowerCase().includes(lower));
  }, []);

  return { lines, append, clear, search, autoScroll, setAutoScroll };
}

export default useOutputBuffer;
