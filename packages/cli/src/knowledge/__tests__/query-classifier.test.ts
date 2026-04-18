/**
 * Tests for query-classifier.ts — query classification and weight assignment.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { classifyQuery, routeQueryToRepos } from '../query-classifier.js';

// ---------------------------------------------------------------------------
// classifyQuery
// ---------------------------------------------------------------------------

describe('classifyQuery', () => {
  it('classifies camelCase identifier', () => {
    const result = classifyQuery('getUserById');
    assert.equal(result.type, 'identifier');
    assert.equal(result.shouldUseTrigram, true);
  });

  it('classifies snake_case identifier', () => {
    const result = classifyQuery('get_user_by_id');
    assert.equal(result.type, 'identifier');
  });

  it('classifies PascalCase identifier', () => {
    const result = classifyQuery('UserService');
    assert.equal(result.type, 'identifier');
  });

  it('classifies natural language question', () => {
    const result = classifyQuery('how does authentication work');
    assert.equal(result.type, 'natural-language');
    assert.equal(result.shouldUseTrigram, false);
  });

  it('classifies long natural language phrase', () => {
    const result = classifyQuery('explain the data pipeline flow from ingestion to storage');
    assert.equal(result.type, 'natural-language');
  });

  it('classifies file path', () => {
    const result = classifyQuery('src/utils/auth.ts');
    assert.equal(result.type, 'path');
    assert.equal(result.shouldUseTrigram, true);
  });

  it('classifies Windows-style path', () => {
    const result = classifyQuery('src\\utils\\auth.ts');
    assert.equal(result.type, 'path');
  });

  it('classifies ERR_ error code', () => {
    const result = classifyQuery('ERR_MODULE_NOT_FOUND');
    assert.equal(result.type, 'error-code');
    assert.equal(result.shouldUseTrigram, true);
  });

  it('classifies hex error code', () => {
    const result = classifyQuery('0xDEADBEEF');
    assert.equal(result.type, 'error-code');
  });

  it('classifies numeric error code', () => {
    const result = classifyQuery('E12345');
    assert.equal(result.type, 'error-code');
  });

  it('classifies HTTP status as error-code in short query', () => {
    const result = classifyQuery('404');
    assert.equal(result.type, 'error-code');
  });

  it('classifies mixed query with identifier and question word', () => {
    const result = classifyQuery('how does getUserById handle null input');
    assert.equal(result.type, 'mixed');
    assert.equal(result.shouldUseTrigram, true);
  });

  it('classifies mixed query with identifier and long phrase', () => {
    const result = classifyQuery('getUserById authentication service layer middleware pipeline');
    assert.equal(result.type, 'mixed');
  });

  it('treats empty query as natural-language', () => {
    const result = classifyQuery('');
    assert.equal(result.type, 'natural-language');
    assert.equal(result.shouldUseTrigram, false);
  });

  it('treats whitespace-only query as natural-language', () => {
    const result = classifyQuery('   ');
    assert.equal(result.type, 'natural-language');
  });

  // --- Weight structure ---

  it('returns weights that sum to 1.0 for identifier', () => {
    const { weights } = classifyQuery('getUserById');
    const sum = weights.vector + weights.bm25 + weights.graph;
    assert.ok(Math.abs(sum - 1.0) < 0.001, `Weights sum to ${sum}, expected ~1.0`);
  });

  it('returns weights that sum to 1.0 for natural-language', () => {
    const { weights } = classifyQuery('how does authentication work');
    const sum = weights.vector + weights.bm25 + weights.graph;
    assert.ok(Math.abs(sum - 1.0) < 0.001, `Weights sum to ${sum}, expected ~1.0`);
  });

  it('returns weights that sum to 1.0 for path', () => {
    const { weights } = classifyQuery('src/utils/auth.ts');
    const sum = weights.vector + weights.bm25 + weights.graph;
    assert.ok(Math.abs(sum - 1.0) < 0.001, `Weights sum to ${sum}, expected ~1.0`);
  });

  it('returns weights that sum to 1.0 for error-code', () => {
    const { weights } = classifyQuery('ERR_MODULE_NOT_FOUND');
    const sum = weights.vector + weights.bm25 + weights.graph;
    assert.ok(Math.abs(sum - 1.0) < 0.001, `Weights sum to ${sum}, expected ~1.0`);
  });

  it('returns weights that sum to 1.0 for mixed', () => {
    const { weights } = classifyQuery('how does getUserById handle null input');
    const sum = weights.vector + weights.bm25 + weights.graph;
    assert.ok(Math.abs(sum - 1.0) < 0.001, `Weights sum to ${sum}, expected ~1.0`);
  });

  it('identifier has higher bm25 weight than vector', () => {
    const { weights } = classifyQuery('getUserById');
    assert.ok(weights.bm25 > weights.vector, 'bm25 should dominate for identifiers');
  });

  it('natural-language has higher vector weight than bm25', () => {
    const { weights } = classifyQuery('how does authentication work');
    assert.ok(weights.vector > weights.bm25, 'vector should dominate for NL queries');
  });

  it('always returns an explanation string', () => {
    const queries = [
      'getUserById',
      'how does auth work',
      'src/utils/auth.ts',
      'ERR_MODULE_NOT_FOUND',
      'how getUserById works in the pipeline layer',
      '',
    ];
    for (const q of queries) {
      const result = classifyQuery(q);
      assert.equal(typeof result.explanation, 'string');
      assert.ok(result.explanation.length > 0, `Empty explanation for query: "${q}"`);
    }
  });
});

// ---------------------------------------------------------------------------
// routeQueryToRepos
// ---------------------------------------------------------------------------

describe('routeQueryToRepos', () => {
  const profiles = [
    { name: 'auth-service', domain: 'authentication', description: 'Handles user login and JWT tokens', technologies: ['typescript', 'express'] },
    { name: 'billing-api', domain: 'billing', description: 'Stripe integration for subscriptions', technologies: ['python', 'fastapi'] },
    { name: 'frontend-app', domain: 'ui', description: 'React dashboard for user management', technologies: ['typescript', 'react'] },
  ];

  it('returns all repos when profiles is empty', () => {
    const result = routeQueryToRepos('auth', []);
    assert.deepEqual(result, []);
  });

  it('returns all repos when query has no matching tokens', () => {
    const result = routeQueryToRepos('', profiles);
    assert.equal(result.length, 3);
  });

  it('scores auth-service higher for authentication query', () => {
    const result = routeQueryToRepos('authentication login', profiles);
    assert.ok(result.includes('auth-service'), 'auth-service should be in results');
    assert.equal(result[0], 'auth-service', 'auth-service should be first');
  });

  it('scores billing-api higher for billing query', () => {
    const result = routeQueryToRepos('stripe subscription billing', profiles);
    assert.ok(result.includes('billing-api'));
  });

  it('respects maxRepos option', () => {
    const result = routeQueryToRepos('typescript', profiles, { maxRepos: 1 });
    assert.ok(result.length <= 1);
  });
});
