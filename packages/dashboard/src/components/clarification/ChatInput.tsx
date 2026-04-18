import React, { useState, useRef, useEffect } from 'react';

export interface ChatInputProps {
  onSend: (text: string) => void;
  placeholder?: string;
  disabled?: boolean;
}

export function ChatInput({ onSend, placeholder = 'Type a response...', disabled }: ChatInputProps) {
  const [text, setText] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!disabled) inputRef.current?.focus();
  }, [disabled]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (text.trim()) {
      onSend(text.trim());
      setText('');
    }
  };

  return (
    <form onSubmit={handleSubmit} style={{ display: 'flex', gap: 'var(--space-sm)' }}>
      <input
        ref={inputRef}
        className="input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        style={{ flex: 1 }}
      />
      <button type="submit" className="btn btn-primary btn-sm" disabled={disabled || !text.trim()}>
        Send
      </button>
    </form>
  );
}

export default ChatInput;
