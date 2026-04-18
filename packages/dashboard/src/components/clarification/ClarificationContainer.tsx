import React from 'react';
import { ClarificationPanel } from './ClarificationPanel.js';
import { useClarificationChat } from './useClarificationChat.js';
import type { ClarificationResponse } from './types.js';

export interface ClarificationContainerProps {
  onResponse?: (response: ClarificationResponse) => void;
}

export function ClarificationContainer({ onResponse }: ClarificationContainerProps) {
  const chat = useClarificationChat({ onResponse });

  return (
    <ClarificationPanel
      messages={chat.messages}
      pendingRequest={chat.pendingRequest}
      onSelectOption={chat.selectOption}
      onSendText={chat.sendText}
      status={chat.status}
    />
  );
}

export default ClarificationContainer;
