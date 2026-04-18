// Task parser for TASKS.md format

export interface ParsedTask {
  id: string;
  repo: string;
  description: string;
  dependencies: string[];
  files: string[];
}

export interface TaskPlan {
  project: string;
  tasks: ParsedTask[];
  repoOrder: string[];
}

/**
 * Parses TASKS.md content into a structured TaskPlan.
 *
 * Expected format:
 *   ## repo-name
 *   - [ ] TASK-001: description
 *     depends: TASK-002
 *     files: path/to/file.ts
 *   - [ ] TASK-002: another task
 *     files: src/index.ts, src/util.ts
 */
export function parseTasksMarkdown(content: string, project: string): TaskPlan {
  const tasks: ParsedTask[] = [];
  const repoOrderSet: string[] = [];
  let currentRepo = '';

  const lines = content.split('\n');

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match repo headings: ## repo-name
    const repoMatch = line.match(/^##\s+(.+)$/);
    if (repoMatch) {
      currentRepo = repoMatch[1].trim();
      if (!repoOrderSet.includes(currentRepo)) {
        repoOrderSet.push(currentRepo);
      }
      continue;
    }

    // Match task lines: - [ ] TASK-001: description
    const taskMatch = line.match(/^-\s+\[[ x]?\]\s+(TASK-\d+):\s+(.+)$/);
    if (taskMatch) {
      const task: ParsedTask = {
        id: taskMatch[1],
        repo: currentRepo,
        description: taskMatch[2].trim(),
        dependencies: [],
        files: [],
      };

      // Look ahead for depends: and files: lines
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j].trim();

        if (nextLine.startsWith('depends:')) {
          const deps = nextLine.replace('depends:', '').trim();
          task.dependencies = deps
            .split(',')
            .map((d) => d.trim())
            .filter(Boolean);
        } else if (nextLine.startsWith('files:')) {
          const files = nextLine.replace('files:', '').trim();
          task.files = files
            .split(',')
            .map((f) => f.trim())
            .filter(Boolean);
        } else if (
          nextLine.startsWith('- ') ||
          nextLine.startsWith('## ') ||
          nextLine === ''
        ) {
          break;
        }
      }

      tasks.push(task);
    }
  }

  return {
    project,
    tasks,
    repoOrder: repoOrderSet,
  };
}

/**
 * Returns tasks in topological order based on dependencies.
 * Tasks with no dependencies come first.
 */
export function getTopologicalOrder(tasks: ParsedTask[]): ParsedTask[] {
  const circular = detectCircularDependencies(tasks);
  if (circular) {
    throw new Error(
      `Circular dependencies detected: ${circular.map((c) => c.join(' -> ')).join('; ')}`,
    );
  }

  const taskMap = new Map<string, ParsedTask>();
  for (const task of tasks) {
    taskMap.set(task.id, task);
  }

  const visited = new Set<string>();
  const result: ParsedTask[] = [];

  function visit(taskId: string): void {
    if (visited.has(taskId)) return;
    visited.add(taskId);

    const task = taskMap.get(taskId);
    if (!task) return;

    for (const dep of task.dependencies) {
      visit(dep);
    }

    result.push(task);
  }

  for (const task of tasks) {
    visit(task.id);
  }

  return result;
}

/**
 * Detects circular dependencies in tasks.
 * Returns an array of cycles (each cycle is an array of task IDs), or null if none found.
 */
export function detectCircularDependencies(tasks: ParsedTask[]): string[][] | null {
  const taskMap = new Map<string, ParsedTask>();
  for (const task of tasks) {
    taskMap.set(task.id, task);
  }

  const cycles: string[][] = [];
  const visited = new Set<string>();
  const inStack = new Set<string>();
  const path: string[] = [];

  function dfs(taskId: string): void {
    if (inStack.has(taskId)) {
      // Found a cycle
      const cycleStart = path.indexOf(taskId);
      const cycle = [...path.slice(cycleStart), taskId];
      cycles.push(cycle);
      return;
    }

    if (visited.has(taskId)) return;

    visited.add(taskId);
    inStack.add(taskId);
    path.push(taskId);

    const task = taskMap.get(taskId);
    if (task) {
      for (const dep of task.dependencies) {
        dfs(dep);
      }
    }

    path.pop();
    inStack.delete(taskId);
  }

  for (const task of tasks) {
    dfs(task.id);
  }

  return cycles.length > 0 ? cycles : null;
}
