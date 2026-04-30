/**
 * Tests for BlobStore — content-addressed blob storage.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { BlobStore } from '../blob-store.js';
import { blobPath } from '../key.js';

describe('BlobStore', () => {
  let home: string;
  let store: BlobStore;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'anvil-blobs-'));
    store = new BlobStore(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('write() returns the sha of the content and the fan-out path', () => {
    const result = store.write('hello world');
    assert.match(result.sha, /^[0-9a-f]{64}$/);
    assert.equal(result.bytes, Buffer.byteLength('hello world'));
    assert.equal(result.path, blobPath(home, result.sha));
    assert.ok(existsSync(result.path));
  });

  it('read() returns the stored bytes', () => {
    const { sha } = store.write('hello world');
    const buf = store.read(sha);
    assert.ok(buf);
    assert.equal(buf!.toString('utf-8'), 'hello world');
  });

  it('read() returns null for unknown shas', () => {
    const missing = store.read('0'.repeat(64));
    assert.equal(missing, null);
  });

  it('exists() reports presence without reading bytes', () => {
    const { sha } = store.write('x');
    assert.equal(store.exists(sha), true);
    assert.equal(store.exists('1'.repeat(64)), false);
  });

  it('write() dedupes identical content (no rewrite, same sha)', () => {
    const a = store.write('same content');
    const mtimeA = readFileSync(a.path).toString('utf-8');
    const b = store.write('same content');
    assert.equal(a.sha, b.sha);
    assert.equal(a.path, b.path);
    const mtimeB = readFileSync(b.path).toString('utf-8');
    assert.equal(mtimeA, mtimeB);
  });

  it('write() distinguishes different content', () => {
    const a = store.write('one');
    const b = store.write('two');
    assert.notEqual(a.sha, b.sha);
  });

  it('write() accepts Buffer directly', () => {
    const buf = Buffer.from([0x01, 0x02, 0x03]);
    const { sha } = store.write(buf);
    const read = store.read(sha);
    assert.ok(read);
    assert.deepEqual(Array.from(read!), [0x01, 0x02, 0x03]);
  });

  it('gc() removes orphan blobs and keeps referenced ones', () => {
    const keep = store.write('keep me');
    const drop1 = store.write('drop 1');
    const drop2 = store.write('drop 2');

    const referenced = new Set<string>([keep.sha]);
    const result = store.gc(referenced);

    assert.equal(result.deleted, 2);
    assert.ok(result.bytes > 0);
    assert.equal(store.exists(keep.sha), true);
    assert.equal(store.exists(drop1.sha), false);
    assert.equal(store.exists(drop2.sha), false);
  });

  it('gc() on empty store returns zero counts', () => {
    const result = store.gc(new Set());
    assert.equal(result.deleted, 0);
    assert.equal(result.bytes, 0);
  });
});
