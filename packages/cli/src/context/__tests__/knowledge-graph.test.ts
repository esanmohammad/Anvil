// Phase 1 — verify loadKnowledgeGraph degrades gracefully when the
// retriever path is unreachable. The success path is exercised by the
// end-to-end smoke in Phase 11 (a real KB is required).

import { loadKnowledgeGraph } from '../knowledge-graph.js';

describe('loadKnowledgeGraph', () => {
  it('returns empty string when project dir is missing and no query', async () => {
    const result = await loadKnowledgeGraph('definitely-not-a-project-' + Date.now());
    expect(result).toBe('');
  });

  it('falls through gracefully when retriever path is unreachable', async () => {
    // featureQuery is set, so the retriever-first branch fires; with no
    // LanceDB index for an unknown project, getRetriever throws → catch
    // swallows it → keyword/blob fallback also produces nothing → ''.
    // Contract: function returns a string, never throws.
    const result = await loadKnowledgeGraph(
      'definitely-not-a-project-' + Date.now(),
      'some bug query',
    );
    expect(typeof result).toBe('string');
    expect(result).toBe('');
  });
});
