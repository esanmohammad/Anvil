/**
 * Tests for buildContractGraph — joins contracts with consumer calls.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildContractGraph } from '../contract-graph-builder.js';
import type { Contract } from '../contract-types.js';
import type { ConsumerCall } from '../contract-consumer-detector.js';

function mkContract(overrides: Partial<Contract> = {}): Contract {
  return {
    kind: 'openapi',
    sourceFile: 'openapi.yaml',
    repoName: 'producer',
    name: 'api',
    endpoints: [],
    types: {},
    ...overrides,
  };
}

function mkCall(overrides: Partial<ConsumerCall> = {}): ConsumerCall {
  return {
    repoName: 'consumer',
    filePath: 'src/client.ts',
    lineNumber: 10,
    language: 'ts',
    kind: 'http',
    method: 'GET',
    urlOrPath: '/api/users',
    snippet: "fetch('/api/users')",
    ...overrides,
  };
}

describe('buildContractGraph', () => {
  it('matches an exact endpoint', () => {
    const contract = mkContract({
      endpoints: [
        { id: 'GET /api/users', method: 'GET', path: '/api/users', responseType: 'User' },
      ],
    });
    const call = mkCall();
    const graph = buildContractGraph([contract], [call]);
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.edges[0].endpointId, 'GET /api/users');
    assert.equal(graph.edges[0].consumerRepo, 'consumer');
    assert.equal(graph.orphans.length, 0);
    assert.equal(graph.calls[0].matchedEndpointId, 'GET /api/users');
  });

  it('matches a path-param endpoint', () => {
    const contract = mkContract({
      endpoints: [
        { id: 'GET /api/users/{id}', method: 'GET', path: '/api/users/{id}', responseType: 'User' },
      ],
    });
    const call = mkCall({ urlOrPath: '/api/users/123/' });
    const graph = buildContractGraph([contract], [call]);
    assert.equal(graph.edges.length, 1);
    assert.equal(graph.edges[0].endpointId, 'GET /api/users/{id}');
    assert.equal(graph.orphans.length, 0);
  });

  it('records a call as orphan when nothing matches', () => {
    const contract = mkContract({
      endpoints: [
        { id: 'GET /api/users', method: 'GET', path: '/api/users', responseType: 'User' },
      ],
    });
    const call = mkCall({ urlOrPath: '/api/completely-different', method: 'POST' });
    const graph = buildContractGraph([contract], [call]);
    assert.equal(graph.edges.length, 0);
    assert.equal(graph.orphans.length, 1);
    assert.equal(graph.orphans[0].urlOrPath, '/api/completely-different');
  });

  it('dedupes edges on the same call site matching the same endpoint', () => {
    const contract = mkContract({
      endpoints: [
        { id: 'GET /api/users', method: 'GET', path: '/api/users', responseType: 'User' },
      ],
    });
    const call = mkCall();
    const dup = mkCall();
    const graph = buildContractGraph([contract], [call, dup]);
    assert.equal(graph.edges.length, 1);
  });
});
