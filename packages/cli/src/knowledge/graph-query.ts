import type { ProjectGraphBuilder } from './project-graph-builder.js';

/** Find all nodes related to a query by matching labels/file paths */
export function findRelatedNodes(
  graph: ProjectGraphBuilder,
  query: string,
  maxResults: number = 20,
): string[] {
  const g = graph.getGraph();
  const queryLower = query.toLowerCase();
  const scored: Array<{ node: string; score: number }> = [];

  g.forEachNode((node: string, attrs: any) => {
    const label = (attrs.label ?? '').toLowerCase();
    const file = (attrs.file ?? '').toLowerCase();
    const nodeLower = node.toLowerCase();

    let score = 0;

    // Exact match on label
    if (label === queryLower) {
      score = 1.0;
    } else if (label.includes(queryLower)) {
      score = 0.8;
    } else if (file.includes(queryLower)) {
      score = 0.6;
    } else if (nodeLower.includes(queryLower)) {
      score = 0.4;
    }

    // Also check individual query terms for multi-word queries
    if (score === 0) {
      const terms = queryLower.split(/\s+/).filter(t => t.length > 2);
      const matchCount = terms.filter(t =>
        label.includes(t) || file.includes(t) || nodeLower.includes(t),
      ).length;
      if (matchCount > 0) {
        score = 0.3 * (matchCount / terms.length);
      }
    }

    if (score > 0) {
      scored.push({ node, score });
    }
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, maxResults).map(s => s.node);
}

/** Get the dependency chain for a specific node (BFS up to depth) */
export function getDependencyChain(
  graph: ProjectGraphBuilder,
  nodeId: string,
  depth: number = 3,
): string[] {
  // Delegates to the builder's BFS impact analysis
  return graph.impactAnalysis([nodeId], depth);
}

/** Find which repos are affected by changes to given files */
export function findAffectedRepos(
  graph: ProjectGraphBuilder,
  changedFiles: string[],
): string[] {
  const g = graph.getGraph();
  const affectedRepos = new Set<string>();

  // Find nodes that match the changed files
  const matchingNodes: string[] = [];
  g.forEachNode((node: string, attrs: any) => {
    const file = attrs.file ?? '';
    const label = attrs.label ?? '';
    for (const changedFile of changedFiles) {
      // Match by file path suffix (handles relative vs absolute paths)
      if (file && (file.endsWith(changedFile) || changedFile.endsWith(file))) {
        matchingNodes.push(node);
        break;
      }
      // Match by label containing filename
      const fileName = changedFile.split('/').pop() ?? changedFile;
      if (label.includes(fileName.replace(/\.[^.]+$/, ''))) {
        matchingNodes.push(node);
        break;
      }
    }
  });

  // BFS from matching nodes to find impacted nodes
  const impacted = graph.impactAnalysis(matchingNodes, 3);

  // Collect unique repos from impacted nodes
  for (const nodeId of impacted) {
    if (g.hasNode(nodeId)) {
      const repo = g.getNodeAttribute(nodeId, 'repo');
      if (repo) affectedRepos.add(repo);
    }
  }

  return [...affectedRepos];
}
