/** Bounded-scratch writer: clone → process → discard + ls-remote sha skip. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { processRepoPipeline, getRemoteSha, getRepoSha } from '../repo-pipeline.js';

const tag = randomBytes(5).toString('hex');
const origin = join(tmpdir(), `writer-origin-${tag}`);
const base = join(tmpdir(), `writer-kb-${tag}`);
const scratch = join(tmpdir(), `writer-scratch-${tag}`, 'r1');
mkdirSync(join(origin, 'src'), { recursive: true });
mkdirSync(base, { recursive: true });
writeFileSync(join(origin, 'src', 'a.ts'), 'export function writerAlpha(x: number){ return x + 1; }\n');
const g = (c: string) => execSync(c, { cwd: origin, stdio: 'ignore' });
g('git init -q'); g('git add -A'); g('git -c user.email=t@t -c user.name=t commit -qm init');

describe('bounded-scratch writer pipeline', () => {
  it('getRemoteSha matches HEAD without a local checkout', () => {
    assert.equal(getRemoteSha(`file://${origin}`), getRepoSha(origin));
  });

  it('clones, processes, and discards the scratch checkout', async () => {
    const res = await processRepoPipeline({
      repoName: 'r1', repoPath: scratch, language: 'typescript', basePath: base,
      project: 'p', chunking: { maxTokens: 500, contextEnrichment: 'structural' },
      doChunk: true, force: true, cloneUrl: `file://${origin}`,
    });
    assert.ok(res.chunkCount > 0, 'chunks produced from the cloned repo');
    assert.equal(res.sha, getRepoSha(origin), 'sha captured before discard');
    assert.ok(!existsSync(scratch), 'clone removed after processing');
    assert.ok(existsSync(join(base, 'r1', 'chunks.shard.ndjson')), 'shard persisted');
    rmSync(base, { recursive: true, force: true }); rmSync(origin, { recursive: true, force: true });
  });
});
