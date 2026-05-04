// Tests for engineer-task-bundler: parseTasks, extractAllTaskFiles, bundleFiles.

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

import {
  bundleFiles,
  extractAllTaskFiles,
  groupTasksForExecution,
  parseTasks,
  type ParsedTask,
} from '../engineer-task-bundler.js';

function writeRepoFile(repoRoot: string, rel: string, contents: string): void {
  const abs = join(repoRoot, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, contents, 'utf8');
}

function makeTempRepo(): string {
  return mkdtempSync(join(tmpdir(), 'engineer-task-bundler-'));
}

const SAMPLE_TASKS_MD = `# Task Breakdown

## Tasks

### TASK-001: Add TypeScript Interfaces to src/types.ts
- **Estimate**: S
- **Prerequisites**: None
- **Scope**: \`src/types.ts\` (append only, no modifications to existing code)
- **Description**:
  1. Append three new interfaces.
- **Spec Reference**: "Data Model › \`src/types.ts\` — New Interfaces"

---

### TASK-002: Create Two Files
- **Estimate**: M
- **Prerequisites**: TASK-001
- **Scope**: \`src/components/BookingPage/BookingStepIndicator.tsx\`, \`src/components/BookingPage/BookingStepIndicator.module.css\`
- **Description**:
  1. Create files.
- **Spec Reference**: "Component Design › \`BookingStepIndicator.tsx\`"

---

### TASK-003: Reuse src/types.ts and add another
- **Scope**: \`src/types.ts\`, \`src/constants/trips.ts\` (new file)
- **Spec Reference**: Plain unquoted reference goes here
`;

describe('parseTasks', () => {
  it('parses multiple tasks with single-file and multi-file scopes', () => {
    const tasks = parseTasks(SAMPLE_TASKS_MD);
    assert.equal(tasks.length, 3);

    const [t1, t2, t3] = tasks;

    assert.equal(t1.id, 'TASK-001');
    assert.match(t1.title, /Add TypeScript Interfaces/);
    assert.deepEqual(t1.files, ['src/types.ts']);
    assert.equal(t1.specRef, 'Data Model › `src/types.ts` — New Interfaces');

    assert.equal(t2.id, 'TASK-002');
    assert.deepEqual(t2.files, [
      'src/components/BookingPage/BookingStepIndicator.tsx',
      'src/components/BookingPage/BookingStepIndicator.module.css',
    ]);
    assert.equal(t2.specRef, 'Component Design › `BookingStepIndicator.tsx`');

    assert.equal(t3.id, 'TASK-003');
    assert.deepEqual(t3.files, ['src/types.ts', 'src/constants/trips.ts']);
  });

  it('tolerates malformed entries — skips tasks without a Scope line', () => {
    const md = `### TASK-100: No scope here
- **Estimate**: S
- **Description**: Nothing scopes anything.

### TASK-101: Has scope
- **Scope**: \`a.ts\`
- **Spec Reference**: "X"
`;
    const tasks = parseTasks(md);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, 'TASK-101');
    assert.deepEqual(tasks[0].files, ['a.ts']);
  });

  it('returns null specRef when the line is absent', () => {
    const md = `### TASK-001: Only scope
- **Scope**: \`only.ts\`
`;
    const tasks = parseTasks(md);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].specRef, null);
  });
});

describe('extractAllTaskFiles', () => {
  it('dedupes across tasks and preserves first-seen order', () => {
    const all = extractAllTaskFiles(SAMPLE_TASKS_MD);
    assert.deepEqual(all, [
      'src/types.ts',
      'src/components/BookingPage/BookingStepIndicator.tsx',
      'src/components/BookingPage/BookingStepIndicator.module.css',
      'src/constants/trips.ts',
    ]);
  });
});

describe('Spec ref extraction', () => {
  it('handles both quoted and unquoted forms', () => {
    const md = `### TASK-001: Quoted
- **Scope**: \`a.ts\`
- **Spec Reference**: "Quoted › value"

### TASK-002: Unquoted
- **Scope**: \`b.ts\`
- **Spec Reference**: Unquoted plain text
`;
    const tasks = parseTasks(md);
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].specRef, 'Quoted › value');
    assert.equal(tasks[1].specRef, 'Unquoted plain text');
  });
});

describe('bundleFiles', () => {
  it('bundles two small files into a single <files> block', () => {
    const repo = makeTempRepo();
    writeRepoFile(repo, 'src/a.ts', 'export const A = 1;\n');
    writeRepoFile(repo, 'src/b.ts', 'export const B = 2;\n');

    const result = bundleFiles({
      repoPath: repo,
      files: ['src/a.ts', 'src/b.ts'],
    });

    assert.deepEqual(result.included, ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(result.truncated, []);
    assert.deepEqual(result.skipped, []);
    assert.match(result.block, /^<files>\n/);
    assert.match(result.block, /<\/files>$/);
    assert.match(result.block, /<file path="src\/a\.ts">\nexport const A = 1;\n\n<\/file>/);
    assert.match(result.block, /<file path="src\/b\.ts">\nexport const B = 2;\n\n<\/file>/);
    assert.equal(result.bytes, Buffer.byteLength(result.block, 'utf8'));
  });

  it('truncates per-file content and marks it in truncated', () => {
    const repo = makeTempRepo();
    const big = 'x'.repeat(5000);
    writeRepoFile(repo, 'src/big.ts', big);

    const result = bundleFiles({
      repoPath: repo,
      files: ['src/big.ts'],
      maxFileBytes: 100,
    });

    assert.deepEqual(result.included, ['src/big.ts']);
    assert.deepEqual(result.truncated, ['src/big.ts']);
    assert.deepEqual(result.skipped, []);
    assert.match(result.block, /\.\.\. \[truncated, \d+ more bytes\]/);
    const remaining = 5000 - 100;
    assert.match(result.block, new RegExp(`\\[truncated, ${remaining} more bytes\\]`));
  });

  it('rejects files past the budget cap with reason "budget"', () => {
    const repo = makeTempRepo();
    const body = 'a'.repeat(200);
    writeRepoFile(repo, 'src/one.ts', body);
    writeRepoFile(repo, 'src/two.ts', body);
    writeRepoFile(repo, 'src/three.ts', body);

    // Budget tight enough for two files but not three.
    const result = bundleFiles({
      repoPath: repo,
      files: ['src/one.ts', 'src/two.ts', 'src/three.ts'],
      maxBytes: 600,
      maxFileBytes: 1000,
    });

    assert.deepEqual(result.included, ['src/one.ts', 'src/two.ts']);
    assert.deepEqual(result.skipped, [{ path: 'src/three.ts', reason: 'budget' }]);
    assert.ok(result.bytes <= 600);
  });

  it('reports a missing file as skipped with reason "missing"', () => {
    const repo = makeTempRepo();
    writeRepoFile(repo, 'src/exists.ts', 'export {};\n');

    const result = bundleFiles({
      repoPath: repo,
      files: ['src/exists.ts', 'src/missing.ts'],
    });

    assert.deepEqual(result.included, ['src/exists.ts']);
    assert.deepEqual(result.skipped, [{ path: 'src/missing.ts', reason: 'missing' }]);
  });
});

function makeTask(overrides: Partial<ParsedTask> & { id: string }): ParsedTask {
  return {
    id: overrides.id,
    title: overrides.title ?? overrides.id,
    files: overrides.files ?? [`${overrides.id.toLowerCase()}.ts`],
    specRef: overrides.specRef ?? null,
    prerequisites: overrides.prerequisites ?? [],
    block: overrides.block ?? `### ${overrides.id}: stub`,
  };
}

describe('parseTasks — prerequisites field', () => {
  it('parses a basic comma-separated prerequisites list', () => {
    const md = `### TASK-010: With prereqs
- **Prerequisites**: TASK-001, TASK-002
- **Scope**: \`a.ts\`
`;
    const tasks = parseTasks(md);
    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0].prerequisites, ['TASK-001', 'TASK-002']);
  });

  it('returns [] when the line says None or is missing', () => {
    const mdNone = `### TASK-001: None case
- **Prerequisites**: None (independent change)
- **Scope**: \`a.ts\`
`;
    const tasksNone = parseTasks(mdNone);
    assert.equal(tasksNone.length, 1);
    assert.deepEqual(tasksNone[0].prerequisites, []);

    const mdMissing = `### TASK-001: No prereq line at all
- **Scope**: \`a.ts\`
`;
    const tasksMissing = parseTasks(mdMissing);
    assert.equal(tasksMissing.length, 1);
    assert.deepEqual(tasksMissing[0].prerequisites, []);
  });

  it('dedupes prerequisites preserving first-seen order', () => {
    const md = `### TASK-010: Dupes
- **Prerequisites**: TASK-002, TASK-001, TASK-002
- **Scope**: \`a.ts\`
`;
    const tasks = parseTasks(md);
    assert.equal(tasks.length, 1);
    assert.deepEqual(tasks[0].prerequisites, ['TASK-002', 'TASK-001']);
  });
});

describe('parseTasks — block field', () => {
  it('captures the full subdoc per task and stops at the next ### TASK- heading', () => {
    const md = `# Heading

### TASK-001: First
- **Scope**: \`a.ts\`
- **Spec Reference**: "X"

---

### TASK-002: Second
- **Scope**: \`b.ts\`
- **Spec Reference**: "Y"
`;
    const tasks = parseTasks(md);
    assert.equal(tasks.length, 2);

    const [t1, t2] = tasks;
    assert.ok(t1.block.startsWith('### TASK-001: First'));
    assert.ok(!t1.block.includes('### TASK-002'));

    assert.ok(t2.block.startsWith('### TASK-002: Second'));
    assert.ok(!t2.block.includes('### TASK-001'));
  });
});

describe('groupTasksForExecution', () => {
  it('returns [] for empty input', () => {
    assert.deepEqual(groupTasksForExecution([]), []);
  });

  it('produces a 1-per-group sequence for a linear chain', () => {
    const t1 = makeTask({ id: 'TASK-001', files: ['a.ts'] });
    const t2 = makeTask({ id: 'TASK-002', files: ['b.ts'], prerequisites: ['TASK-001'] });
    const t3 = makeTask({ id: 'TASK-003', files: ['c.ts'], prerequisites: ['TASK-002'] });

    const groups = groupTasksForExecution([t1, t2, t3]);
    assert.equal(groups.length, 3);
    assert.deepEqual(
      groups.map((g) => g.tasks.map((t) => t.id)),
      [['TASK-001'], ['TASK-002'], ['TASK-003']],
    );
    assert.deepEqual(
      groups.map((g) => g.index),
      [0, 1, 2],
    );
  });

  it('fans out: parallelizes siblings that share a single prerequisite', () => {
    const t1 = makeTask({ id: 'TASK-001', files: ['root.ts'] });
    const t2 = makeTask({ id: 'TASK-002', files: ['left.ts'], prerequisites: ['TASK-001'] });
    const t3 = makeTask({ id: 'TASK-003', files: ['right.ts'], prerequisites: ['TASK-001'] });

    const groups = groupTasksForExecution([t1, t2, t3]);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups[0].tasks.map((t) => t.id), ['TASK-001']);
    assert.deepEqual(groups[1].tasks.map((t) => t.id), ['TASK-002', 'TASK-003']);
  });

  it('splits ready tasks into separate groups when they share a file', () => {
    const t1 = makeTask({ id: 'TASK-001', files: ['shared.ts'] });
    const t2 = makeTask({ id: 'TASK-002', files: ['shared.ts'] });

    const groups = groupTasksForExecution([t1, t2]);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups[0].tasks.map((t) => t.id), ['TASK-001']);
    assert.deepEqual(groups[1].tasks.map((t) => t.id), ['TASK-002']);
  });

  it('treats a prerequisite outside the input list as already satisfied', () => {
    const t1 = makeTask({
      id: 'TASK-005',
      files: ['x.ts'],
      prerequisites: ['TASK-999'],
    });

    const groups = groupTasksForExecution([t1]);
    assert.equal(groups.length, 1);
    assert.deepEqual(groups[0].tasks.map((t) => t.id), ['TASK-005']);
  });

  it('falls back to one task per group when a cycle is detected', () => {
    const t1 = makeTask({ id: 'TASK-001', files: ['a.ts'], prerequisites: ['TASK-002'] });
    const t2 = makeTask({ id: 'TASK-002', files: ['b.ts'], prerequisites: ['TASK-001'] });

    const groups = groupTasksForExecution([t1, t2]);
    assert.equal(groups.length, 2);
    assert.deepEqual(groups[0].tasks.map((t) => t.id), ['TASK-001']);
    assert.deepEqual(groups[1].tasks.map((t) => t.id), ['TASK-002']);
  });
});
