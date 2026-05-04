/**
 * Tests for detectConsumerCalls — regex-based call-site detection.
 * Uses node:test + node:assert/strict.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectConsumerCalls } from '../contract-consumer-detector.js';

describe('detectConsumerCalls', () => {
  let root = '';

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'anvil-ccd-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('detects TypeScript fetch() calls', () => {
    writeFileSync(
      join(root, 'client.ts'),
      [
        "import x from 'y';",
        "const r = await fetch('/api/users');",
        "const r2 = await fetch('https://api.example.com/v1/orders', { method: 'POST' });",
      ].join('\n'),
    );
    const calls = detectConsumerCalls(root, 'repo1');
    const httpCalls = calls.filter((c) => c.kind === 'http');
    assert.equal(httpCalls.length, 2);
    const get = httpCalls.find((c) => c.method === 'GET');
    assert.ok(get);
    assert.equal(get!.urlOrPath, '/api/users');
    assert.equal(get!.language, 'ts');
    assert.equal(get!.lineNumber, 2);
    const post = httpCalls.find((c) => c.method === 'POST');
    assert.ok(post);
    assert.equal(post!.urlOrPath, 'https://api.example.com/v1/orders');
  });

  it('detects TypeScript axios calls', () => {
    writeFileSync(
      join(root, 'svc.ts'),
      [
        "import axios from 'axios';",
        "axios.get('/api/widgets');",
        "axios.put('/api/widgets/42', { name: 'x' });",
      ].join('\n'),
    );
    const calls = detectConsumerCalls(root, 'repo1');
    assert.equal(calls.length, 2);
    const methods = calls.map((c) => c.method).sort();
    assert.deepEqual(methods, ['GET', 'PUT']);
    assert.equal(calls.find((c) => c.method === 'GET')!.urlOrPath, '/api/widgets');
  });

  it('detects Python requests calls', () => {
    writeFileSync(
      join(root, 'client.py'),
      [
        'import requests',
        'r = requests.get("https://api.example.com/users")',
        'r = requests.post("/api/events", json={"a": 1})',
      ].join('\n'),
    );
    const calls = detectConsumerCalls(root, 'py-repo');
    assert.equal(calls.length, 2);
    const get = calls.find((c) => c.method === 'GET');
    assert.ok(get);
    assert.equal(get!.language, 'py');
    assert.equal(get!.urlOrPath, 'https://api.example.com/users');
    assert.equal(calls.find((c) => c.method === 'POST')!.urlOrPath, '/api/events');
  });

  it('detects Go http.Get calls', () => {
    writeFileSync(
      join(root, 'main.go'),
      [
        'package main',
        'import "net/http"',
        'func f() {',
        '  resp, _ := http.Get("https://api.example.com/items")',
        '  req, _ := http.NewRequest("POST", "/api/jobs", nil)',
        '  _ = resp; _ = req',
        '}',
      ].join('\n'),
    );
    const calls = detectConsumerCalls(root, 'go-repo');
    assert.equal(calls.length, 2);
    const get = calls.find((c) => c.method === 'GET');
    const post = calls.find((c) => c.method === 'POST');
    assert.ok(get);
    assert.ok(post);
    assert.equal(get!.language, 'go');
    assert.equal(get!.urlOrPath, 'https://api.example.com/items');
    assert.equal(post!.urlOrPath, '/api/jobs');
  });

  it('detects gRPC stub method calls', () => {
    writeFileSync(
      join(root, 'grpc-client.ts'),
      [
        "import { client } from './stub';",
        'const u = await client.GetUser({ id: 1 });',
        'const c = await client.CreateOrder({ total: 42 });',
      ].join('\n'),
    );
    const calls = detectConsumerCalls(root, 'repo-grpc');
    const grpc = calls.filter((c) => c.kind === 'grpc');
    assert.equal(grpc.length, 2);
    const names = grpc.map((c) => c.method).sort();
    assert.deepEqual(names, ['CreateOrder', 'GetUser']);
  });

  it('skips files larger than maxFileSize', () => {
    const big = 'const x = 1; // ' + 'a'.repeat(2000) + '\n';
    const repeats = 200; // ~400 KB
    writeFileSync(join(root, 'big.ts'), big.repeat(repeats) + "fetch('/skipped');");
    writeFileSync(join(root, 'small.ts'), "fetch('/kept');");
    const calls = detectConsumerCalls(root, 'repo1', { maxFileSize: 50 * 1024 });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].urlOrPath, '/kept');
  });
});
