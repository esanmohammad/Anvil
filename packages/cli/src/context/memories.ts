import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getFFHome } from '../home.js';

export interface Memory {
  timestamp: string;
  type: 'pattern' | 'mistake' | 'preference';
  content: string;
  relevance: number;
}

export async function loadMemories(project: string, limit: number = 20): Promise<Memory[]> {
  const memories: Memory[] = [];

  // Global memories
  const globalPath = join(getFFHome(), 'memory', 'global', 'patterns.jsonl');
  if (existsSync(globalPath)) {
    const lines = (await readFile(globalPath, 'utf-8')).split('\n').filter(l => l.trim());
    for (const line of lines) {
      try { memories.push(JSON.parse(line)); } catch { /* skip invalid */ }
    }
  }

  // Project-specific memories
  const projectPath = join(getFFHome(), 'memory', project, 'patterns.jsonl');
  if (existsSync(projectPath)) {
    const lines = (await readFile(projectPath, 'utf-8')).split('\n').filter(l => l.trim());
    for (const line of lines) {
      try { memories.push(JSON.parse(line)); } catch { /* skip invalid */ }
    }
  }

  // Sort by relevance descending, limit
  return memories
    .sort((a, b) => (b.relevance || 0) - (a.relevance || 0))
    .slice(0, limit);
}
