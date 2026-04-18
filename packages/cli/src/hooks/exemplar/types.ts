// Section F — Exemplar Types

export interface Exemplar {
  filePath: string;
  content: string;
  language: string;
  relevanceScore: number;
  description?: string;
}

export interface ExemplarQuery {
  language: string;
  pattern: string;
  context?: string;
  maxResults?: number;
}

export interface ExemplarCache {
  get(key: string): Exemplar[] | null;
  set(key: string, exemplars: Exemplar[]): void;
  clear(): void;
}
