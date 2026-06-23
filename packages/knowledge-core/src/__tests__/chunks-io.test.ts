import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { writeChunksFile, readChunksFile, findChunksInFile } from '../chunks-io.js';
import type { CodeChunk } from '../types.js';

let tmp = '';

function chunk(id: string, entityName: string, repoName = 'app', filePath = 'a.ts'): CodeChunk {
  return {
    id, filePath, repoName, project: 'demo', startLine: 1, endLine: 2,
    content: `function ${entityName}() {}`, contextPrefix: '', contextualizedContent: '',
    language: 'typescript', entityType: 'function', entityName,
    tokens: 5, imports: [], exports: [],
  };
}

beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'kc-chunks-')); });
afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

describe('chunks-io NDJSON round-trip', () => {
  it('writes and reads back chunks losslessly', async () => {
    const path = join(tmp, 'chunks.json');
    const chunks = [chunk('c1', 'alpha'), chunk('c2', 'beta'), chunk('c3', 'gamma')];
    writeChunksFile(path, chunks);
    const back = await readChunksFile(path);
    assert.equal(back.length, 3);
    assert.deepEqual(back.map((c) => c.id), ['c1', 'c2', 'c3']);
    assert.equal(back[1].entityName, 'beta');
  });

  it('handles an empty chunk list', async () => {
    const path = join(tmp, 'chunks.json');
    writeChunksFile(path, []);
    assert.deepEqual(await readChunksFile(path), []);
  });

  it('round-trips content with embedded newlines', async () => {
    const path = join(tmp, 'chunks.json');
    const c = chunk('c1', 'multi');
    c.content = 'line1\nline2\nline3';
    writeChunksFile(path, [c]);
    const back = await readChunksFile(path);
    assert.equal(back.length, 1);
    assert.equal(back[0].content, 'line1\nline2\nline3');
  });
});

describe('chunks-io legacy compatibility', () => {
  it('reads a legacy single-JSON-array file', async () => {
    const path = join(tmp, 'chunks.json');
    // pre-NDJSON format: one big JSON array
    writeFileSync(path, JSON.stringify([chunk('c1', 'alpha'), chunk('c2', 'beta')]));
    const back = await readChunksFile(path);
    assert.equal(back.length, 2);
    assert.equal(back[0].entityName, 'alpha');
  });
});

describe('findChunksInFile early-exit', () => {
  it('returns only matching chunks up to the limit', async () => {
    const path = join(tmp, 'chunks.json');
    writeChunksFile(path, [chunk('c1', 'login'), chunk('c2', 'logout'), chunk('c3', 'login')]);
    const hits = await findChunksInFile(path, (c) => c.entityName === 'login', 5);
    assert.equal(hits.length, 2);
    assert.ok(hits.every((c) => c.entityName === 'login'));
  });

  it('stops once the limit is reached', async () => {
    const path = join(tmp, 'chunks.json');
    writeChunksFile(path, [chunk('c1', 'x'), chunk('c2', 'x'), chunk('c3', 'x')]);
    const hits = await findChunksInFile(path, () => true, 1);
    assert.equal(hits.length, 1);
  });
});
