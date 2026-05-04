/**
 * Tests for contract-test-author — covers each framework's emission shape,
 * header marker, and scenario expansion.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { authorContractTest } from '../contract-test-author.js';
import { expandScenarios } from '../contract-test-scenarios.js';
import type { Contract, ContractChange } from '../contract-types.js';

function makeContract(overrides: Partial<Contract> = {}): Contract {
  return {
    kind: 'openapi',
    sourceFile: 'openapi.yaml',
    repoName: 'consumer',
    name: 'users-api',
    version: '1.2.0',
    endpoints: [],
    types: {},
    ...overrides,
  };
}

function makeChange(overrides: Partial<ContractChange> = {}): ContractChange {
  return {
    kind: 'field-removed',
    severity: 'breaking',
    path: 'User.email',
    before: 'string',
    description: 'email was removed from User',
    ...overrides,
  };
}

describe('contract-test-author', () => {
  it('emits a TypeScript vitest file with header, describe, and at least one it()', () => {
    const contract = makeContract();
    const scenarios = expandScenarios(makeChange());
    const out = authorContractTest({
      contract,
      consumerRepo: '/tmp/consumer',
      consumerLanguage: 'ts',
      endpointId: 'GET /users/:id',
      scenarios,
      framework: 'vitest',
    });
    assert.equal(out.framework, 'vitest');
    assert.equal(out.language, 'ts');
    assert.ok(out.filePath.startsWith('contract/'));
    assert.ok(out.filePath.endsWith('.test.ts'));
    assert.ok(out.sourceCode.includes('anvil-contract'));
    assert.ok(out.sourceCode.includes("from 'vitest'"));
    assert.ok(out.sourceCode.includes('describe('));
    assert.ok(/\bit\(/.test(out.sourceCode));
  });

  it('emits a pytest file with # header and def test_ functions', () => {
    const contract = makeContract({ name: 'accounts' });
    const scenarios = expandScenarios(makeChange({ kind: 'type-narrowed', before: 'string', after: 'uuid' }));
    const out = authorContractTest({
      contract,
      consumerRepo: '/tmp/consumer-py',
      consumerLanguage: 'py',
      endpointId: 'POST /accounts',
      scenarios,
    });
    assert.equal(out.framework, 'pytest');
    assert.equal(out.language, 'py');
    assert.ok(out.filePath.startsWith('contract/'));
    assert.ok(out.filePath.endsWith('.py'));
    assert.ok(out.sourceCode.startsWith('# anvil-contract'));
    assert.ok(out.sourceCode.includes('import pytest'));
    assert.ok(/def test_\w+\(\):/.test(out.sourceCode));
  });

  it('emits a go-test file with package contract and Test_ funcs', () => {
    const contract = makeContract({ name: 'orders' });
    const scenarios = expandScenarios(makeChange({ kind: 'enum-shrunk', path: 'Order.status', before: 'PAID|REFUNDED|VOID' }));
    const out = authorContractTest({
      contract,
      consumerRepo: '/tmp/consumer-go',
      consumerLanguage: 'go',
      endpointId: 'GET /orders',
      scenarios,
    });
    assert.equal(out.framework, 'go-test');
    assert.equal(out.language, 'go');
    assert.ok(out.filePath.endsWith('_contract_test.go'));
    assert.ok(out.sourceCode.startsWith('// anvil-contract'));
    assert.ok(out.sourceCode.includes('package contract'));
    assert.ok(out.sourceCode.includes('"testing"'));
    assert.ok(/func Test_\w+\(t \*testing\.T\)/.test(out.sourceCode));
  });

  it('emits a JUnit file with @Test methods and DisplayName', () => {
    const contract = makeContract({ name: 'billing' });
    const scenarios = expandScenarios(makeChange({ kind: 'endpoint-removed', path: 'GET /billing/v1' }));
    const out = authorContractTest({
      contract,
      consumerRepo: '/tmp/consumer-java',
      consumerLanguage: 'java',
      endpointId: 'GET /billing/v1',
      scenarios,
    });
    assert.equal(out.framework, 'junit');
    assert.equal(out.language, 'java');
    assert.ok(out.filePath.startsWith('contract/'));
    assert.ok(out.filePath.endsWith('ContractTest.java'));
    assert.ok(out.sourceCode.startsWith('// anvil-contract'));
    assert.ok(out.sourceCode.includes('@Test'));
    assert.ok(out.sourceCode.includes('@DisplayName'));
    assert.ok(out.sourceCode.includes('public class'));
  });

  it('always places the anvil-contract header on line 1', () => {
    const contract = makeContract({ version: '3.0.1' });
    const scenarios = expandScenarios(makeChange());
    for (const lang of ['ts', 'js', 'py', 'go', 'java']) {
      const out = authorContractTest({
        contract,
        consumerRepo: '/tmp',
        consumerLanguage: lang,
        endpointId: 'GET /x',
        scenarios,
      });
      const firstLine = out.sourceCode.split('\n')[0];
      assert.ok(/anvil-contract/.test(firstLine), `header missing for ${lang}: ${firstLine}`);
      assert.ok(firstLine.includes('users-api'), `contract name missing for ${lang}`);
      assert.ok(firstLine.includes('3.0.1'), `version missing for ${lang}`);
    }
  });

  it('expands a ContractChange into >=1 test blocks and propagates through the author', () => {
    const change = makeChange({ kind: 'type-narrowed', path: 'User.age', before: 'number', after: 'int32' });
    const scenarios = expandScenarios(change);
    assert.ok(scenarios.length >= 1);
    assert.equal(scenarios[0].kind, 'happy-path');

    const out = authorContractTest({
      contract: makeContract(),
      consumerRepo: '/tmp',
      consumerLanguage: 'ts',
      endpointId: 'POST /users',
      scenarios,
      framework: 'vitest',
    });
    // Every scenario should produce an it() block.
    const itMatches = out.sourceCode.match(/\bit\(/g) ?? [];
    assert.ok(itMatches.length >= scenarios.length,
      `expected >=${scenarios.length} it() blocks, got ${itMatches.length}`);
  });
});
