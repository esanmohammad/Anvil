import React from 'react';
import type { ChatMessageData } from './types.js';

export interface ChatMessageProps {
  message: ChatMessageData;
}

const roleColors: Record<string, string> = {
  project: 'var(--color-primary)',
  user: 'var(--color-accent)',
  assistant: 'var(--text-secondary)',
};

export function ChatMessage({ message }: ChatMessageProps) {
  const isUser = message.role === 'user';

  return (
    <div
      className="chat-message"
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: isUser ? 'flex-end' : 'flex-start',
        marginBottom: 'var(--space-sm)',
      }}
    >
      <div style={{ fontSize: 'var(--text-xs)', color: 'var(--text-muted)', marginBottom: 2 }}>
        <span style={{ color: roleColors[message.role] }}>{message.role}</span>
        {' '}
        {new Date(message.timestamp).toLocaleTimeString()}
      </div>
      <div
        style={{
          padding: 'var(--space-sm) var(--space-md)',
          background: isUser ? 'var(--color-primary)' : 'var(--bg-card)',
          borderRadius: 'var(--radius-md)',
          maxWidth: '80%',
          fontSize: 'var(--text-sm)',
          color: isUser ? 'white' : 'var(--text-primary)',
        }}
      >
        {message.content}
      </div>
    </div>
  );
}

export default ChatMessage;
