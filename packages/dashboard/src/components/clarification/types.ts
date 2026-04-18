/** Types for the interactive clarification chat */

export interface ChatMessageData {
  id: string;
  role: 'project' | 'user' | 'assistant';
  content: string;
  timestamp: number;
  options?: ClarificationOption[];
  metadata?: Record<string, unknown>;
}

export interface ClarificationOption {
  id: string;
  label: string;
  description?: string;
  value: unknown;
}

export interface ClarificationRequest {
  id: string;
  question: string;
  context: string;
  options: ClarificationOption[];
  required: boolean;
  timeout?: number;
}

export interface ClarificationResponse {
  requestId: string;
  selectedOption?: string;
  freeformText?: string;
  timestamp: number;
}

export type ClarificationStatus = 'idle' | 'waiting' | 'answered' | 'timeout';
