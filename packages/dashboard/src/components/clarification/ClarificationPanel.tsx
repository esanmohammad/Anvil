import React, { useRef, useEffect } from 'react';
import { ChatMessage } from './ChatMessage.js';
import { OptionChips } from './OptionChips.js';
import { ChatInput } from './ChatInput.js';
import type { ChatMessageData, ClarificationRequest } from './types.js';

export interface ClarificationPanelProps {
  messages: ChatMessageData[];
  pendingRequest: ClarificationRequest | null;
  onSelectOption: (optionId: string) => void;
  onSendText: (text: string) => void;
  status: string;
}

export function ClarificationPanel({ messages, pendingRequest, onSelectOption, onSendText, status }: ClarificationPanelProps) {
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div style={{ padding: 'var(--space-sm)', borderBottom: '1px solid var(--border-default)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h3 style={{ fontSize: 'var(--text-base)', fontWeight: 600 }}>Clarification</h3>
        <span style={{ fontSize: 'var(--text-xs)', color: status === 'waiting' ? 'var(--color-warning)' : 'var(--text-muted)' }}>
          {status}
        </span>
      </div>
      <div style={{ flex: 1, overflow: 'auto', padding: 'var(--space-md)' }}>
        {messages.map((msg) => (
          <ChatMessage key={msg.id} message={msg} />
        ))}
        {pendingRequest && pendingRequest.options.length > 0 && (
          <OptionChips
            options={pendingRequest.options}
            onSelect={onSelectOption}
            disabled={status !== 'waiting'}
          />
        )}
        <div ref={bottomRef} />
      </div>
      <div style={{ padding: 'var(--space-sm)', borderTop: '1px solid var(--border-default)' }}>
        <ChatInput onSend={onSendText} disabled={status !== 'waiting'} />
      </div>
    </div>
  );
}

export default ClarificationPanel;
