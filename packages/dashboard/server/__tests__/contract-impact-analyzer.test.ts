/**
 * Tests for analyzeContractImpact — attributes breaking changes to call sites.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { buildContractGraph } from '../contract-graph-builder.js';
import { analyzeContractImpact } from '../contract-impact-analyzer.js';
import type {
  Contract,
  ContractChange,
  ContractDiff,
  ContractEndpoint,
  ContractField,
  ContractType,
} from '../contract-types.js';
import type { ConsumerCall } from '../contract-consumer-detector.js';

function field(name: string, type: string, required = true): ContractField {
  return { name, type, required, nullable: false };
}

function obj(name: string, fields: ContractField[]): ContractType {
  return { name, kind: 'object', fields };
}

function endpoint(
  id: string,
  method: string,
  path: string,
  responseType?: string,
): ContractEndpoint {
  return { id, method, path, responseType };
}

function mkContract(types: ContractType[], endpoints: ContractEndpoint[]): Contract {
  const map: Record<string, ContractType> = {};
  for (const t of types) map[t.name] = t;
  return {
    kind: 'openapi',
    sourceFile: 'openapi.yaml',
    repoName: 'producer',
    name: 'api',
    endpoints,
    types: map,
  };
}

function mkCall(overrides: Partial<ConsumerCall> = {}): ConsumerCall {
  return {
    repoName: 'consumer-a',
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

function mkDiff(before: Contract, after: Contract, changes: ContractChange[]): ContractDiff {
  const breakingCount = changes.filter((c) => c.severity === 'breaking').length;
  return { before, after, changes, breakingCount };
}

function breakingChange(kind: ContractChange['kind'], path: string): ContractChange {
  return { kind, severity: 'breaking', path, description: `${kind} at ${path}` };
}

function nonBreakingChange(kind: ContractChange['kind'], path: string): ContractChange {
  return { kind, severity: 'non-breaking', path, description: `${kind} at ${path}` };
}

describe('analyzeContractImpact', () => {
  it('surfaces all affected consumers for a breaking removal', () => {
    const userBefore = obj('User', [field('id', 'string'), field('email', 'string')]);
    const userAfter = obj('User', [field('id', 'string')]);
    const ep = endpoint('GET /api/users', 'GET', '/api/users', 'User');
    const before = mkContract([userBefore], [ep]);
    const after = mkContract([userAfter], [ep]);
    const diff = mkDiff(before, after, [breakingChange('field-removed', 'User.email')]);

    const calls = [
      mkCall({ repoName: 'consumer-a', filePath: 'a.ts', lineNumber: 1 }),
      mkCall({ repoName: 'consumer-b', filePath: 'b.ts', lineNumber: 2 }),
    ];
    const graph = buildContractGraph([before], calls);
    const report = analyzeContractImpact(diff, graph);

    assert.equal(report.breakingChanges.length, 1);
    assert.equal(report.affectedCallsByChange.length, 1);
    assert.equal(report.affectedCallsByChange[0].calls.length, 2);
    assert.deepEqual(report.affectedConsumerRepos, ['consumer-a', 'consumer-b']);
    assert.equal(report.totalBreakingCallSites, 2);
  });

  it('returns empty affected calls when no breaking changes', () => {
    const user = obj('User', [field('id', 'string')]);
    const ep = endpoint('GET /api/users', 'GET', '/api/users', 'User');
    const before = mkContract([user], [ep]);
    const after = mkContract([user], [ep]);
    const diff = mkDiff(before, after, [nonBreakingChange('field-added', 'User.nickname')]);

    const graph = buildContractGraph([before], [mkCall()]);
    const report = analyzeContractImpact(diff, graph);
    assert.equal(report.breakingChanges.length, 0);
    assert.equal(report.affectedCallsByChange.length, 0);
    assert.equal(report.totalBreakingCallSites, 0);
    assert.deepEqual(report.affectedConsumerRepos, []);
  });

  it('traces transitive field changes via a nested response type', () => {
    const address = obj('Address', [field('street', 'string'), field('zip', 'string')]);
    const user = obj('User', [field('id', 'string'), field('address', 'Address')]);
    const ep = endpoint('GET /api/users', 'GET', '/api/users', 'User');
    const contract = mkContract([address, user], [ep]);
    const diff = mkDiff(contract, contract, [breakingChange('field-removed', 'Address.zip')]);

    const graph = buildContractGraph([contract], [mkCall({ urlOrPath: '/api/users' })]);
    const report = analyzeContractImpact(diff, graph);
    assert.equal(report.affectedCallsByChange.length, 1);
    assert.equal(report.affectedCallsByChange[0].calls.length, 1);
    assert.equal(report.affectedCallsByChange[0].calls[0].repoName, 'consumer-a');
  });
});
