import { useState, useCallback } from 'react';
import type { ChatMessageData, ClarificationRequest, ClarificationResponse, ClarificationStatus } from './types.js';

export interface UseClarificationChatOptions {
  onResponse?: (response: ClarificationResponse) => void;
}

export function useClarificationChat({ onResponse }: UseClarificationChatOptions = {}) {
  const [messages, setMessages] = useState<ChatMessageData[]>([]);
  const [pendingRequest, setPendingRequest] = useState<ClarificationRequest | null>(null);
  const [status, setStatus] = useState<ClarificationStatus>('idle');

  const addMessage = useCallback((msg: ChatMessageData) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const handleRequest = useCallback((request: ClarificationRequest) => {
    setPendingRequest(request);
    setStatus('waiting');
    addMessage({
      id: `msg-${Date.now()}`,
      role: 'project',
      content: request.question,
      timestamp: Date.now(),
      options: request.options,
    });
  }, [addMessage]);

  const respond = useCallback((response: ClarificationResponse) => {
    setStatus('answered');
    setPendingRequest(null);
    addMessage({
      id: `msg-${Date.now()}`,
      role: 'user',
      content: response.freeformText ?? response.selectedOption ?? '',
      timestamp: response.timestamp,
    });
    onResponse?.(response);
  }, [addMessage, onResponse]);

  const selectOption = useCallback((optionId: string) => {
    if (!pendingRequest) return;
    respond({
      requestId: pendingRequest.id,
      selectedOption: optionId,
      timestamp: Date.now(),
    });
  }, [pendingRequest, respond]);

  const sendText = useCallback((text: string) => {
    if (!pendingRequest) {
      addMessage({
        id: `msg-${Date.now()}`,
        role: 'user',
        content: text,
        timestamp: Date.now(),
      });
      return;
    }
    respond({
      requestId: pendingRequest.id,
      freeformText: text,
      timestamp: Date.now(),
    });
  }, [pendingRequest, respond, addMessage]);

  const clear = useCallback(() => {
    setMessages([]);
    setPendingRequest(null);
    setStatus('idle');
  }, []);

  return {
    messages,
    pendingRequest,
    status,
    handleRequest,
    selectOption,
    sendText,
    clear,
    addMessage,
  };
}

export default useClarificationChat;
