// Resolve repository build order via topological sort

export interface RepoWithDeps {
  name: string;
  type: 'library' | 'service' | 'mfe';
  dependencies: string[];
}

/**
 * Resolves the build order for repositories.
 * Library repos come before service repos.
 * Producer before consumer (topological sort).
 * Throws on circular dependencies.
 */
export function resolveRepoBuildOrder(repos: RepoWithDeps[]): string[] {
  const repoMap = new Map<string, RepoWithDeps>();
  for (const repo of repos) {
    repoMap.set(repo.name, repo);
  }

  // Detect circular dependencies
  const visited = new Set<string>();
  const inStack = new Set<string>();

  function detectCycle(name: string, path: string[]): string[] | null {
    if (inStack.has(name)) {
      const cycleStart = path.indexOf(name);
      return [...path.slice(cycleStart), name];
    }
    if (visited.has(name)) return null;

    visited.add(name);
    inStack.add(name);
    path.push(name);

    const repo = repoMap.get(name);
    if (repo) {
      for (const dep of repo.dependencies) {
        const cycle = detectCycle(dep, path);
        if (cycle) return cycle;
      }
    }

    path.pop();
    inStack.delete(name);
    return null;
  }

  for (const repo of repos) {
    const cycle = detectCycle(repo.name, []);
    if (cycle) {
      throw new Error(
        `Circular dependency detected: ${cycle.join(' -> ')}`,
      );
    }
  }

  // Topological sort
  const sorted: string[] = [];
  const sortVisited = new Set<string>();

  function visit(name: string): void {
    if (sortVisited.has(name)) return;
    sortVisited.add(name);

    const repo = repoMap.get(name);
    if (repo) {
      for (const dep of repo.dependencies) {
        visit(dep);
      }
    }

    sorted.push(name);
  }

  // Visit libraries first, then services, then mfes
  const typeOrder: RepoWithDeps['type'][] = ['library', 'service', 'mfe'];
  for (const type of typeOrder) {
    for (const repo of repos) {
      if (repo.type === type) {
        visit(repo.name);
      }
    }
  }

  return sorted;
}
