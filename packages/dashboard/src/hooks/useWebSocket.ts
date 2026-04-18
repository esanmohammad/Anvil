import { useEffect, useRef, useState, useCallback } from 'react';

export type WSReadyState = 'connecting' | 'connected' | 'disconnected' | 'reconnecting';

export interface UseWebSocketOptions {
  url: string;
  autoReconnect?: boolean;
  maxRetries?: number;
  baseDelay?: number;
  maxDelay?: number;
  onMessage?: (data: unknown) => void;
  onConnect?: () => void;
  onDisconnect?: () => void;
  onError?: (error: Event) => void;
}

export interface UseWebSocketReturn {
  readyState: WSReadyState;
  send: (data: unknown) => void;
  subscribe: (channel: string, filters?: Record<string, string>) => void;
  unsubscribe: (channel: string) => void;
  lastMessage: unknown | null;
  reconnect: () => void;
}

export function useWebSocket(options: UseWebSocketOptions): UseWebSocketReturn {
  const {
    url,
    autoReconnect = true,
    maxRetries = 10,
    baseDelay = 1000,
    maxDelay = 30000,
    onMessage,
    onConnect,
    onDisconnect,
    onError,
  } = options;

  const wsRef = useRef<WebSocket | null>(null);
  const retriesRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [readyState, setReadyState] = useState<WSReadyState>('disconnected');
  const [lastMessage, setLastMessage] = useState<unknown | null>(null);

  const connect = useCallback(() => {
    try {
      const ws = new WebSocket(url);
      wsRef.current = ws;
      setReadyState('connecting');

      ws.onopen = () => {
        setReadyState('connected');
        retriesRef.current = 0;
        onConnect?.();
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);
          setLastMessage(data);
          onMessage?.(data);
        } catch {
          // non-JSON message
        }
      };

      ws.onerror = (event) => {
        onError?.(event);
      };

      ws.onclose = () => {
        setReadyState('disconnected');
        wsRef.current = null;
        onDisconnect?.();

        if (autoReconnect && retriesRef.current < maxRetries) {
          // exponential backoff: delay doubles each retry
          const delay = Math.min(baseDelay * Math.pow(2, retriesRef.current), maxDelay);
          setReadyState('reconnecting');
          retriesRef.current++;
          reconnectTimerRef.current = setTimeout(connect, delay);
        }
      };
    } catch {
      setReadyState('disconnected');
    }
  }, [url, autoReconnect, maxRetries, baseDelay, maxDelay, onConnect, onDisconnect, onError, onMessage]);

  const send = useCallback((data: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify(data));
    }
  }, []);

  const subscribe = useCallback((channel: string, filters?: Record<string, string>) => {
    send({ type: 'subscribe', channel, filters });
  }, [send]);

  const unsubscribe = useCallback((channel: string) => {
    send({ type: 'unsubscribe', channel });
  }, [send]);

  const reconnect = useCallback(() => {
    wsRef.current?.close();
    retriesRef.current = 0;
    connect();
  }, [connect]);

  useEffect(() => {
    connect();
    return () => {
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      wsRef.current?.close();
    };
  }, [connect]);

  return { readyState, send, subscribe, unsubscribe, lastMessage, reconnect };
}

export default useWebSocket;
