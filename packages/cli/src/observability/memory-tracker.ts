/**
 * MemoryInfluenceTracker — record injected memories, detect references, compute influence.
 */

export interface InjectedMemory {
  id: string;
  content: string;
  injectedAt: string;
  source: string;
}

export interface MemoryInfluenceReport {
  totalInjected: number;
  referencedCount: number;
  influenceRate: number; // 0-1
  references: MemoryReference[];
}

export interface MemoryReference {
  memoryId: string;
  matchedTerms: string[];
  outputSnippet: string;
}

export class MemoryInfluenceTracker {
  private memories: InjectedMemory[] = [];

  /** Record an injected memory. */
  recordInjection(id: string, content: string, source: string): void {
    this.memories.push({
      id,
      content,
      injectedAt: new Date().toISOString(),
      source,
    });
  }

  /** Detect references to injected memories in output text. */
  detectReferences(output: string): MemoryInfluenceReport {
    const references: MemoryReference[] = [];

    for (const memory of this.memories) {
      // Extract key terms from the memory (words > 4 chars for significance)
      const terms = this.extractKeyTerms(memory.content);
      const matchedTerms = terms.filter((term) =>
        output.toLowerCase().includes(term.toLowerCase()),
      );

      if (matchedTerms.length >= Math.max(1, Math.floor(terms.length * 0.3))) {
        // Find the first matching snippet in output
        const firstMatch = matchedTerms[0];
        const idx = output.toLowerCase().indexOf(firstMatch.toLowerCase());
        const start = Math.max(0, idx - 30);
        const end = Math.min(output.length, idx + firstMatch.length + 30);
        references.push({
          memoryId: memory.id,
          matchedTerms,
          outputSnippet: output.slice(start, end),
        });
      }
    }

    const referencedCount = references.length;
    const influenceRate =
      this.memories.length > 0 ? referencedCount / this.memories.length : 0;

    return {
      totalInjected: this.memories.length,
      referencedCount,
      influenceRate,
      references,
    };
  }

  /** Get all injected memories. */
  getMemories(): readonly InjectedMemory[] {
    return this.memories;
  }

  /** Compute influence rate for current state. */
  getInfluenceRate(output: string): number {
    return this.detectReferences(output).influenceRate;
  }

  private extractKeyTerms(content: string): string[] {
    return content
      .split(/\s+/)
      .map((w) => w.replace(/[^a-zA-Z0-9-_]/g, ''))
      .filter((w) => w.length > 4);
  }
}
