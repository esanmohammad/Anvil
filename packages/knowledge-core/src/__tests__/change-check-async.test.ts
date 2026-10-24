/**
 * The async change-check helpers (used to check many repos concurrently)
 * must report exactly what their synchronous twins do.
 */

import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  getUncommittedChanges, getUncommittedChangesAsync, getWorkingTreeState, getWorkingTreeStateAsync,
} from '../git-diff.js';
import { getRepoSha, getRepoShaAsync } from '../repo-pipeline.js';

const repo = join(tmpdir(), `chk-async-${randomBytes(5).toString('hex')}`);
after(() => rmSync(repo, { recursive: true, force: true }));
const git = (...args: string[]) =>
  execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd: repo, stdio: 'ignore' });

describe('async change checks', () => {
  it('match the sync helpers on a repo with staged, unstaged, deleted and untracked changes', async () => {
    mkdirSync(join(repo, 'src'), { recursive: true });
    for (const f of ['a.ts', 'b.ts', 'c.ts']) writeFileSync(join(repo, 'src', f), `export const ${f[0]} = 1;\n`);
    git('init', '-q', '-b', 'main');
    git('add', '-A');
    git('commit', '-qm', 'init');

    writeFileSync(join(repo, 'src', 'a.ts'), 'export const a = 2;\n'); // unstaged
    writeFileSync(join(repo, 'src', 'b.ts'), 'export const b = 2;\n');
    git('add', 'src/b.ts'); // staged
    rmSync(join(repo, 'src', 'c.ts')); // deleted
    writeFileSync(join(repo, 'src', 'd.ts'), 'export const d = 1;\n'); // untracked

    assert.deepEqual(await getUncommittedChangesAsync(repo), getUncommittedChanges(repo));
    const state = await getWorkingTreeStateAsync(repo);
    assert.deepEqual(state, getWorkingTreeState(repo));
    assert.deepEqual(Object.keys(state).sort(), ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']);
    assert.equal(await getRepoShaAsync(repo), getRepoSha(repo));
    assert.match((await getRepoShaAsync(repo)) ?? '', /^[0-9a-f]{40}$/);
  });

  it('report no sha for a path that is not a repo', async () => {
    assert.equal(await getRepoShaAsync(tmpdir()), getRepoSha(tmpdir()));
  });
});
