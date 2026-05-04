/**
 * Phase 1 of AGENT-PROCESS-CONSOLIDATION — verify `defaultAdapterFactory`
 * enriches an `AdapterRequest` with workspace-rooted skills + MCP discovery
 * before constructing the bridge.
 *
 * Five cases per the plan:
 *   1. Non-Claude + skill present → projectPrompt extended with skill block.
 *   2. Claude + mcp.json present → claudeMcpConfigPath set on request.
 *   3. Skill `allowed-tools` constraint narrows caller's allowedTools.
 *   4. No workspaceDir → request returned unchanged (back-compat).
 *   5. Claude + skill present → projectPrompt NOT extended (claude-cli
 *      auto-loads skills itself).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { enrichRequestWithWorkspace } from '../default-adapter-factory.js';
import type { AdapterRequest } from '../adapter.js';

function makeRequest(overrides: Partial<AdapterRequest> = {}): AdapterRequest {
  return {
    prompt: 'do a thing',
    model: 'claude-sonnet-4-6',
    sessionId: 'sess-123',
    cwd: '/tmp',
    ...overrides,
  };
}

function makeWorkspaceWithSkill(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-skill-'));
  const skillDir = join(dir, '.claude', 'skills', 'test-skill');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: test-skill',
      'description: Always end every response with a fox emoji.',
      '---',
      '',
      '# Test skill body',
      '',
      'When invoked, append a 🦊 to the final assistant message.',
      '',
    ].join('\n'),
  );
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeWorkspaceWithMcp(): { dir: string; mcpPath: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-mcp-'));
  const mcpPath = join(dir, 'mcp.json');
  writeFileSync(
    mcpPath,
    JSON.stringify({
      mcpServers: {
        fixture: { command: 'node', args: ['fake.js'] },
      },
    }),
  );
  return {
    dir,
    mcpPath,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function makeWorkspaceWithNarrowingSkill(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'anvil-narrow-'));
  const skillDir = join(dir, '.claude', 'skills', 'read-only');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    [
      '---',
      'name: read-only',
      'description: Read-only mode.',
      'allowed-tools:',
      '  - read_file',
      '  - grep',
      '---',
      '',
      '# Read-only skill body',
      '',
    ].join('\n'),
  );
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe('enrichRequestWithWorkspace', () => {
  it('non-Claude: appends skill block to projectPrompt', () => {
    const ws = makeWorkspaceWithSkill();
    try {
      const req = makeRequest({
        model: 'qwen2.5-coder:7b',
        projectPrompt: 'BASE PERSONA',
        workspaceDir: ws.dir,
      });
      const out = enrichRequestWithWorkspace(req, 'ollama');
      assert.notStrictEqual(out, req);
      assert.ok(typeof out.projectPrompt === 'string', 'projectPrompt must be set');
      assert.match(out.projectPrompt!, /BASE PERSONA/, 'base persona retained');
      assert.match(out.projectPrompt!, /test-skill/, 'skill name surfaces in block');
      assert.match(out.projectPrompt!, /fox emoji/, 'skill description surfaces in block');
    } finally {
      ws.cleanup();
    }
  });

  it('Claude: sets claudeMcpConfigPath when mcp.json is discovered', () => {
    const ws = makeWorkspaceWithMcp();
    try {
      const req = makeRequest({
        model: 'claude-sonnet-4-6',
        workspaceDir: ws.dir,
      });
      const out = enrichRequestWithWorkspace(req, 'claude');
      assert.equal(out.claudeMcpConfigPath, ws.mcpPath);
    } finally {
      ws.cleanup();
    }
  });

  it('non-Claude: skill allowed-tools narrows caller allowedTools', () => {
    const ws = makeWorkspaceWithNarrowingSkill();
    try {
      const req = makeRequest({
        model: 'qwen2.5-coder:7b',
        workspaceDir: ws.dir,
        allowedTools: ['read_file', 'grep', 'bash', 'edit'],
      });
      const out = enrichRequestWithWorkspace(req, 'ollama');
      assert.deepEqual(
        [...(out.allowedTools ?? [])].sort(),
        ['grep', 'read_file'],
        'skill allowed-tools intersects with caller policy (skills can subtract, never expand)',
      );
    } finally {
      ws.cleanup();
    }
  });

  it('no workspaceDir: returns request unchanged (back-compat)', () => {
    const req = makeRequest({ projectPrompt: 'untouched' });
    const out = enrichRequestWithWorkspace(req, 'ollama');
    assert.strictEqual(out, req, 'same reference returned when no enrichment applies');
  });

  it('Claude path: skill block NOT injected (claude-cli auto-loads .claude/skills/)', () => {
    const ws = makeWorkspaceWithSkill();
    try {
      const req = makeRequest({
        model: 'claude-sonnet-4-6',
        projectPrompt: 'BASE PERSONA',
        workspaceDir: ws.dir,
      });
      const out = enrichRequestWithWorkspace(req, 'claude');
      // Skill block must NOT be injected for Claude — claude-cli auto-loads
      // skills from .claude/skills/ itself; double-loading would duplicate
      // the bullet list. (claudeMcpConfigPath may be set if the user has a
      // global ~/.claude/mcp.json — the rank-5 fallback in findMcpConfigPath.
      // We don't assert on it here because the test cares only about skill
      // injection, and isolating $HOME would over-couple the test.)
      assert.equal(
        out.projectPrompt,
        'BASE PERSONA',
        'projectPrompt left alone on Claude path',
      );
    } finally {
      ws.cleanup();
    }
  });
});
