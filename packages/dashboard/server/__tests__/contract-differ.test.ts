/**
 * Tests for diffContracts — covers the core change classifications.
 * Uses node:test + node:assert/strict.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { diffContracts } from '../contract-differ.js';
import type { Contract, ContractField, ContractType } from '../contract-types.js';

function obj(name: string, fields: ContractField[]): ContractType {
  return { name, kind: 'object', fields };
}
function enumT(name: string, vals: string[]): ContractType {
  return { name, kind: 'enum', fields: [], enumValues: vals };
}
function field(
  name: string,
  type: string,
  required = false,
  nullable = false,
  enumValues?: string[],
): ContractField {
  const f: ContractField = { name, type, required, nullable };
  if (enumValues) f.enumValues = enumValues;
  return f;
}

function contract(
  types: ContractType[],
  endpoints: Contract['endpoints'] = [],
): Contract {
  const map: Record<string, ContractType> = {};
  for (const t of types) map[t.name] = t;
  return {
    kind: 'openapi',
    sourceFile: 'openapi.yaml',
    repoName: 'repo',
    name: 'api',
    endpoints,
    types: map,
  };
}

describe('diffContracts', () => {
  it('flags removed field as breaking', () => {
    const before = contract([obj('User', [field('id', 'string', true), field('email', 'string', true)])]);
    const after = contract([obj('User', [field('id', 'string', true)])]);
    const d = diffContracts(before, after);
    assert.equal(d.breakingCount, 1);
    assert.equal(d.changes[0].kind, 'field-removed');
    assert.equal(d.changes[0].path, 'User.email');
  });

  it('flags added optional field as non-breaking', () => {
    const before = contract([obj('User', [field('id', 'string', true)])]);
    const after = contract([obj('User', [field('id', 'string', true), field('email', 'string', false)])]);
    const d = diffContracts(before, after);
    assert.equal(d.breakingCount, 0);
    assert.equal(d.changes.length, 1);
    assert.equal(d.changes[0].kind, 'field-added');
    assert.equal(d.changes[0].severity, 'non-breaking');
  });

  it('flags narrowing a nullable string to a non-nullable string as breaking', () => {
    const before = contract([obj('User', [field('email', 'string|null', false, true)])]);
    const after = contract([obj('User', [field('email', 'string', false, false)])]);
    const d = diffContracts(before, after);
    assert.equal(d.breakingCount, 1);
    assert.equal(d.changes[0].kind, 'type-narrowed');
  });

  it('flags widening a non-nullable string to nullable as non-breaking', () => {
    const before = contract([obj('User', [field('email', 'string', false, false)])]);
    const after = contract([obj('User', [field('email', 'string|null', false, true)])]);
    const d = diffContracts(before, after);
    assert.equal(d.breakingCount, 0);
    assert.equal(d.changes[0].kind, 'type-widened');
  });

  it('flags a shrunk enum as breaking', () => {
    const before = contract([enumT('Role', ['ADMIN', 'USER', 'GUEST'])]);
    const after = contract([enumT('Role', ['ADMIN', 'USER'])]);
    const d = diffContracts(before, after);
    assert.equal(d.breakingCount, 1);
    assert.equal(d.changes[0].kind, 'enum-shrunk');
  });

  it('flags an extended enum as non-breaking', () => {
    const before = contract([enumT('Role', ['ADMIN', 'USER'])]);
    const after = contract([enumT('Role', ['ADMIN', 'USER', 'GUEST'])]);
    const d = diffContracts(before, after);
    assert.equal(d.breakingCount, 0);
    assert.equal(d.changes[0].kind, 'enum-extended');
  });

  it('flags a removed endpoint as breaking', () => {
    const before = contract(
      [obj('User', [field('id', 'string', true)])],
      [{ id: 'GET /users', method: 'GET', path: '/users', responseType: 'User' }],
    );
    const after = contract([obj('User', [field('id', 'string', true)])], []);
    const d = diffContracts(before, after);
    assert.equal(d.breakingCount, 1);
    assert.equal(d.changes[0].kind, 'endpoint-removed');
  });

  it('returns empty changes when contracts are identical', () => {
    const types: ContractType[] = [
      obj('User', [field('id', 'string', true), field('email', 'string', true)]),
    ];
    const endpoints: Contract['endpoints'] = [
      { id: 'GET /users', method: 'GET', path: '/users', responseType: 'User' },
    ];
    const before = contract(types, endpoints);
    const after = contract(types.map((t) => ({ ...t, fields: [...t.fields] })), [...endpoints]);
    const d = diffContracts(before, after);
    assert.equal(d.breakingCount, 0);
    assert.equal(d.changes.length, 0);
  });

  it('flags a response shape change (field diff inside responseType) as breaking', () => {
    const before = contract(
      [obj('User', [field('id', 'string', true), field('email', 'string', true)])],
      [{ id: 'GET /users', method: 'GET', path: '/users', responseType: 'User' }],
    );
    const after = contract(
      [obj('User', [field('id', 'string', true)])],
      [{ id: 'GET /users', method: 'GET', path: '/users', responseType: 'User' }],
    );
    const d = diffContracts(before, after);
    // Expect field-removed (breaking) and response-shape-changed (breaking).
    assert.ok(d.breakingCount >= 1);
    const reshape = d.changes.find((c) => c.kind === 'response-shape-changed');
    assert.ok(reshape);
    assert.equal(reshape!.severity, 'breaking');
  });
});
