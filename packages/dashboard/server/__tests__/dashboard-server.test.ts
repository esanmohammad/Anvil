/**
 * Light integration tests for dashboard-server module.
 *
 * Uses node:test + node:assert (built-in test runner).
 * These tests verify module loading and utility logic without
 * starting the full HTTP/WebSocket server.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ── .env parser logic ────────────────────────────────────────────────────
//
// The dashboard-server.ts loads ~/.anvil/.env at the top level using a
// simple key=value parser. We replicate that logic here to test it in
// isolation, since the parser runs as a side-effect on import.

/**
 * Parses .env content the same way dashboard-server.ts does.
 * Returns a record of key-value pairs.
 */
function parseEnvContent(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx < 1) continue;
    const key = trimmed.slice(0, eqIdx);
    const val = trimmed.slice(eqIdx + 1);
    result[key] = val;
  }
  return result;
}

describe('.env parser', () => {
  it('parses simple key=value pairs', () => {
    const content = 'API_KEY=abc123\nSECRET=xyz789\n';
    const result = parseEnvContent(content);
    assert.equal(result['API_KEY'], 'abc123');
    assert.equal(result['SECRET'], 'xyz789');
  });

  it('skips comment lines', () => {
    const content = '# This is a comment\nKEY=value\n# Another comment\n';
    const result = parseEnvContent(content);
    assert.equal(Object.keys(result).length, 1);
    assert.equal(result['KEY'], 'value');
  });

  it('skips empty lines', () => {
    const content = '\n\nKEY=value\n\n\n';
    const result = parseEnvContent(content);
    assert.equal(Object.keys(result).length, 1);
    assert.equal(result['KEY'], 'value');
  });

  it('handles values with equals signs', () => {
    const content = 'URL=https://example.com?foo=bar&baz=qux\n';
    const result = parseEnvContent(content);
    assert.equal(result['URL'], 'https://example.com?foo=bar&baz=qux');
  });

  it('handles empty values', () => {
    const content = 'EMPTY=\n';
    const result = parseEnvContent(content);
    assert.equal(result['EMPTY'], '');
  });

  it('ignores lines without equals sign', () => {
    const content = 'NOEQUALS\nKEY=value\n';
    const result = parseEnvContent(content);
    assert.equal(Object.keys(result).length, 1);
    assert.equal(result['KEY'], 'value');
  });

  it('ignores lines where equals is at position 0', () => {
    const content = '=nokey\nKEY=value\n';
    const result = parseEnvContent(content);
    assert.equal(Object.keys(result).length, 1);
    assert.equal(result['KEY'], 'value');
  });

  it('trims whitespace from lines', () => {
    // The parser trims each line, so leading/trailing spaces on the line
    // are removed. The value portion (after '=') keeps its content as-is
    // after the line trim.
    const content = '  KEY=value  \n  OTHER=123  \n';
    const result = parseEnvContent(content);
    assert.equal(result['KEY'], 'value');
    assert.equal(result['OTHER'], '123');
  });

  it('handles multiline .env with mixed content', () => {
    const content = [
      '# API Configuration',
      'OPENAI_API_KEY=sk-test-12345',
      '',
      '# Database',
      'DATABASE_URL=postgres://user:pass@localhost:5432/db',
      'REDIS_URL=redis://localhost:6379',
      '',
      '# Empty value',
      'DEBUG=',
    ].join('\n');

    const result = parseEnvContent(content);
    assert.equal(Object.keys(result).length, 4);
    assert.equal(result['OPENAI_API_KEY'], 'sk-test-12345');
    assert.equal(result['DATABASE_URL'], 'postgres://user:pass@localhost:5432/db');
    assert.equal(result['REDIS_URL'], 'redis://localhost:6379');
    assert.equal(result['DEBUG'], '');
  });
});

// ── Module exports ───────────────────────────────────────────────────────

describe('provider-registry module exports', () => {
  it('loads without crashing', async () => {
    // Dynamically import to verify module loads cleanly
    const mod = await import('../provider-registry.js');
    assert.ok(typeof mod.discoverProviders === 'function', 'should export discoverProviders');
    assert.ok(typeof mod.getModelsForCapability === 'function', 'should export getModelsForCapability');
    assert.ok(typeof mod.getAgenticProviders === 'function', 'should export getAgenticProviders');
    assert.ok(typeof mod.invalidateProviderCache === 'function', 'should export invalidateProviderCache');
  });
});

describe('project-loader module exports', () => {
  it('loads without crashing', async () => {
    const mod = await import('../project-loader.js');
    assert.ok(typeof mod.ProjectLoader === 'function', 'should export ProjectLoader class');
    assert.ok(typeof mod.discoverProjectFromDirectory === 'function', 'should export discoverProjectFromDirectory');
    assert.ok(typeof mod.createProjectFromScan === 'function', 'should export createProjectFromScan');
  });
});
