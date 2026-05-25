/**
 * Tests for stage-permissions: every canonical stage has a known set,
 * unknown stages fail closed (read-only), and the resolver returns a
 * deduped sorted list of tool names.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  STAGE_TOOL_PERMISSIONS,
  allowedToolsForStage,
  permissionClassesForStage,
} from '../routing/stage-permissions.js';

const READ_ONLY = ['glob', 'grep', 'list', 'read_file'];
// Wave 5 — build now carries `recall_memory` (the agent-callable
// hybridSearch tool). Bounded by a 3-call budget inside the executor.
const FULL = ['bash', 'edit', 'glob', 'grep', 'list', 'read_file', 'recall_memory', 'write_file'];

describe('STAGE_TOOL_PERMISSIONS — canonical pipeline stages', () => {
  it('clarify is read-only', () => {
    assert.deepEqual(STAGE_TOOL_PERMISSIONS.clarify, ['read']);
  });
  it('analysis stages (requirements/specs/tasks) are read-only', () => {
    assert.deepEqual(STAGE_TOOL_PERMISSIONS.requirements, ['read']);
    assert.deepEqual(STAGE_TOOL_PERMISSIONS['repo-requirements'], ['read']);
    assert.deepEqual(STAGE_TOOL_PERMISSIONS.specs, ['read']);
    assert.deepEqual(STAGE_TOOL_PERMISSIONS.tasks, ['read']);
  });
  it('implementation stages (build/validate) carry full read+write+exec plus recall (Wave 5); ship stays no-recall', () => {
    assert.deepEqual(STAGE_TOOL_PERMISSIONS.build, ['read', 'write', 'exec', 'recall']);
    assert.deepEqual(STAGE_TOOL_PERMISSIONS.validate, ['read', 'write', 'exec', 'recall']);
    assert.deepEqual(STAGE_TOOL_PERMISSIONS.ship, ['read', 'write', 'exec']);
  });
});

describe('STAGE_TOOL_PERMISSIONS — ad-hoc commands', () => {
  it('fix and fix-loop are full plus recall (Wave 5)', () => {
    assert.deepEqual(STAGE_TOOL_PERMISSIONS.fix, ['read', 'write', 'exec', 'recall']);
    assert.deepEqual(STAGE_TOOL_PERMISSIONS['fix-loop'], ['read', 'write', 'exec', 'recall']);
  });
  it('review, research carry read + recall; plan stays read-only', () => {
    assert.deepEqual(STAGE_TOOL_PERMISSIONS.review, ['read', 'recall']);
    assert.deepEqual(STAGE_TOOL_PERMISSIONS.research, ['read', 'recall']);
    assert.deepEqual(STAGE_TOOL_PERMISSIONS.plan, ['read']);
  });
});

describe('allowedToolsForStage', () => {
  it('returns deduped sorted tool list for read-only stages', () => {
    // `clarify` is pure read; `research` carries recall (Wave 5).
    assert.deepEqual(allowedToolsForStage('clarify'), READ_ONLY);
    assert.deepEqual(
      allowedToolsForStage('research'),
      ['glob', 'grep', 'list', 'read_file', 'recall_memory'],
    );
  });
  it('returns full set for build (Wave 5 adds recall_memory)', () => {
    assert.deepEqual(allowedToolsForStage('build'), FULL);
  });
  it('falls back to read-only for unknown stage (fail-closed)', () => {
    assert.deepEqual(allowedToolsForStage('not-a-real-stage'), READ_ONLY);
  });
});

describe('permissionClassesForStage', () => {
  it('returns the class list for known stages (Wave 5 adds recall)', () => {
    assert.deepEqual(permissionClassesForStage('build'), ['read', 'write', 'exec', 'recall']);
    assert.deepEqual(permissionClassesForStage('research'), ['read', 'recall']);
  });
  it('falls back to read for unknown stages', () => {
    assert.deepEqual(permissionClassesForStage('eldritch-stage'), ['read']);
  });
  it('returns a fresh array (caller can mutate)', () => {
    const a = permissionClassesForStage('build');
    a.push('read');
    const b = permissionClassesForStage('build');
    assert.deepEqual(b, ['read', 'write', 'exec', 'recall']);
  });
});
