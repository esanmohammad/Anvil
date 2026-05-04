/**
 * Tests for PipelineAuditLog (NDJSON append-only audit trail).
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  existsSync,
  appendFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PipelineAuditLog } from '../pipeline-audit-log.js';

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-audit-'));
}

describe('PipelineAuditLog', () => {
  let home: string;
  let log: PipelineAuditLog;

  beforeEach(() => {
    home = tmpHome();
    log = new PipelineAuditLog(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('record() appends entries and list() returns them in order', () => {
    log.record({ runId: 'r1', project: 'demo', event: 'paused', actor: 'system' });
    log.record({ runId: 'r1', project: 'demo', event: 'approved', actor: 'alice' });

    const all = log.list('demo');
    assert.equal(all.length, 2);
    assert.equal(all[0]!.event, 'paused');
    assert.equal(all[1]!.event, 'approved');
    assert.ok(all[0]!.id && all[0]!.at);
  });

  it('list() filters by runId and event', () => {
    log.record({ runId: 'r1', project: 'demo', event: 'paused', actor: 'system' });
    log.record({ runId: 'r2', project: 'demo', event: 'paused', actor: 'system' });
    log.record({ runId: 'r1', project: 'demo', event: 'approved', actor: 'alice' });

    const byRun = log.list('demo', { runId: 'r1' });
    assert.equal(byRun.length, 2);

    const byEvent = log.list('demo', { event: 'approved' });
    assert.equal(byEvent.length, 1);
    assert.equal(byEvent[0]!.actor, 'alice');
  });

  it('skips malformed lines and still returns valid entries', () => {
    log.record({ runId: 'r1', project: 'demo', event: 'paused', actor: 'system' });
    const path = join(home, 'pipeline-audit', 'demo', 'audit.log');
    appendFileSync(path, '{not json\n', 'utf-8');
    log.record({ runId: 'r1', project: 'demo', event: 'approved', actor: 'bob' });

    const all = log.list('demo');
    assert.equal(all.length, 2);
    assert.equal(all[0]!.event, 'paused');
    assert.equal(all[1]!.event, 'approved');
  });

  it('rotates to audit.log.1 when active log exceeds threshold', () => {
    const dir = join(home, 'pipeline-audit', 'demo');
    const active = join(dir, 'audit.log');
    const rotated = join(dir, 'audit.log.1');
    // Seed a file that is already oversized — next record() should rotate.
    log.record({ runId: 'r0', project: 'demo', event: 'paused', actor: 'system' });
    const filler = 'x'.repeat(5 * 1024 * 1024 + 10);
    writeFileSync(active, filler, 'utf-8');
    assert.ok(!existsSync(rotated));

    log.record({ runId: 'r1', project: 'demo', event: 'approved', actor: 'alice' });

    assert.ok(existsSync(rotated), 'rotated file should exist');
    const after = log.list('demo');
    // After rotation the active log should contain only the newly appended entry.
    assert.equal(after.length, 1);
    assert.equal(after[0]!.event, 'approved');
  });

  it('tail(n) returns the last n entries in file order', () => {
    for (let i = 0; i < 10; i++) {
      log.record({
        runId: `r${i}`,
        project: 'demo',
        event: 'paused',
        actor: 'system',
      });
    }
    const last3 = log.tail('demo', 3);
    assert.equal(last3.length, 3);
    assert.equal(last3[0]!.runId, 'r7');
    assert.equal(last3[1]!.runId, 'r8');
    assert.equal(last3[2]!.runId, 'r9');
  });
});
