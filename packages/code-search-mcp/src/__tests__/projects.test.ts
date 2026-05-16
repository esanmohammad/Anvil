import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  ProjectRegistry,
  projectAccessAllowed,
  checkProjectQuota,
} from '../projects/registry.js';

/**
 * P8 — project registry + scope-aware auth + per-project quota.
 */

let dir = '';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cs-projects-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeProject(name: string, body: string): void {
  const d = join(dir, 'projects', name);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, 'project.yaml'), body, 'utf-8');
}

describe('ProjectRegistry', () => {
  it('reload() discovers all projects with project.yaml', () => {
    writeProject('alpha', `workspace: /tmp/alpha\nrepos: [a, b]\nscopes: [team-x]\n`);
    writeProject('beta', `workspace: /tmp/beta\n`);
    // Directory without project.yaml is ignored.
    mkdirSync(join(dir, 'projects', 'ignored'), { recursive: true });

    const reg = new ProjectRegistry(dir);
    const list = reg.reload();
    assert.equal(list.length, 2);
    const names = new Set(list.map((p) => p.name));
    assert.ok(names.has('alpha'));
    assert.ok(names.has('beta'));
    const alpha = reg.get('alpha')!;
    assert.equal(alpha.workspaceDir, '/tmp/alpha');
    assert.deepEqual(alpha.repos, ['a', 'b']);
    assert.deepEqual(alpha.scopes, ['team-x']);
  });

  it('reload() applies quotas defaults when omitted', () => {
    writeProject('plain', `workspace: /tmp/plain\n`);
    const reg = new ProjectRegistry(dir);
    reg.reload();
    const p = reg.get('plain')!;
    assert.equal(p.quotas.maxQueriesPerMinute, 100);
  });

  it('reload() reads custom quotas', () => {
    writeProject('tenant', `workspace: /tmp/tenant\nquotas:\n  max_queries_per_minute: 5\n  max_embedding_cost_usd: 1\n`);
    const reg = new ProjectRegistry(dir);
    reg.reload();
    const p = reg.get('tenant')!;
    assert.equal(p.quotas.maxQueriesPerMinute, 5);
    assert.equal(p.quotas.maxEmbeddingCostUsd, 1);
  });
});

describe('projectAccessAllowed', () => {
  it('public projects allow any identity', () => {
    const p = {
      name: 'public', workspaceDir: '/p', repos: [], scopes: [],
      config: {} as never, quotas: { maxQueriesPerMinute: 1, maxEmbeddingCostUsd: 0, maxLlmCostUsd: 0 },
    };
    assert.equal(projectAccessAllowed(p, []), true);
    assert.equal(projectAccessAllowed(p, ['some-scope']), true);
  });

  it('scoped projects deny unmatched identities', () => {
    const p = {
      name: 'secret', workspaceDir: '/p', repos: [], scopes: ['team-x'],
      config: {} as never, quotas: { maxQueriesPerMinute: 1, maxEmbeddingCostUsd: 0, maxLlmCostUsd: 0 },
    };
    assert.equal(projectAccessAllowed(p, ['team-y']), false);
    assert.equal(projectAccessAllowed(p, ['team-x']), true);
  });

  it('admin scope * grants access regardless of project scopes', () => {
    const p = {
      name: 'secret', workspaceDir: '/p', repos: [], scopes: ['team-x'],
      config: {} as never, quotas: { maxQueriesPerMinute: 1, maxEmbeddingCostUsd: 0, maxLlmCostUsd: 0 },
    };
    assert.equal(projectAccessAllowed(p, ['*']), true);
  });
});

describe('checkProjectQuota', () => {
  it('blocks once burst exceeds the per-minute cap', () => {
    const p = {
      name: 'q', workspaceDir: '/p', repos: [], scopes: [],
      config: {} as never, quotas: { maxQueriesPerMinute: 2, maxEmbeddingCostUsd: 0, maxLlmCostUsd: 0 },
    };
    assert.equal(checkProjectQuota(p, 'user-1').ok, true);
    assert.equal(checkProjectQuota(p, 'user-1').ok, true);
    const denied = checkProjectQuota(p, 'user-1');
    assert.equal(denied.ok, false);
    if (denied.ok === false) assert.match(denied.reason, /quota exceeded/);
  });

  it('separate identities have independent buckets', () => {
    const p = {
      name: 'q2', workspaceDir: '/p', repos: [], scopes: [],
      config: {} as never, quotas: { maxQueriesPerMinute: 1, maxEmbeddingCostUsd: 0, maxLlmCostUsd: 0 },
    };
    assert.equal(checkProjectQuota(p, 'a').ok, true);
    assert.equal(checkProjectQuota(p, 'b').ok, true);
    assert.equal(checkProjectQuota(p, 'a').ok, false);
  });

  it('maxQueriesPerMinute=0 disables enforcement', () => {
    const p = {
      name: 'q3', workspaceDir: '/p', repos: [], scopes: [],
      config: {} as never, quotas: { maxQueriesPerMinute: 0, maxEmbeddingCostUsd: 0, maxLlmCostUsd: 0 },
    };
    for (let i = 0; i < 1000; i++) assert.equal(checkProjectQuota(p, 'user').ok, true);
  });
});
