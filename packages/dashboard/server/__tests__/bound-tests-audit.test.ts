/**
 * Tests for BoundTestsAuditLog (NDJSON append-only audit trail for Regression
 * Guard Phase 2).
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

import { BoundTestsAuditLog } from '../bound-tests-audit.js';

function tmpHome(): string {
  return mkdtempSync(join(tmpdir(), 'anvil-bound-audit-'));
}

describe('BoundTestsAuditLog', () => {
  let home: string;
  let log: BoundTestsAuditLog;

  beforeEach(() => {
    home = tmpHome();
    log = new BoundTestsAuditLog(home);
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  it('record() appends entries and list() returns them in order', () => {
    log.record({
      project: 'demo',
      filePath: 'tests/foo.spec.ts',
      incidentId: 'INC-1',
      event: 'bound',
      actor: 'system',
    });
    log.record({
      project: 'demo',
      filePath: 'tests/foo.spec.ts',
      incidentId: 'INC-1',
      event: 'overridden',
      actor: 'alice',
      details: { reason: 'replaced by broader coverage' },
    });

    const all = log.list('demo');
    assert.equal(all.length, 2);
    assert.equal(all[0]!.event, 'bound');
    assert.equal(all[1]!.event, 'overridden');
    assert.ok(all[0]!.id && all[0]!.at);
  });

  it('list() filters by event', () => {
    log.record({ project: 'demo', filePath: 'a.ts', event: 'bound',    actor: 'system' });
    log.record({ project: 'demo', filePath: 'a.ts', event: 'verified', actor: 'system' });
    log.record({ project: 'demo', filePath: 'b.ts', event: 'bound',    actor: 'system' });

    const verified = log.list('demo', { event: 'verified' });
    assert.equal(verified.length, 1);
    assert.equal(verified[0]!.filePath, 'a.ts');

    const byFile = log.list('demo', { filePath: 'b.ts' });
    assert.equal(byFile.length, 1);
    assert.equal(byFile[0]!.event, 'bound');
  });

  it('rotates to audit.log.1 when active log exceeds threshold', () => {
    const dir = join(home, 'bound-tests-audit', 'demo');
    const active = join(dir, 'audit.log');
    const rotated = join(dir, 'audit.log.1');

    log.record({ project: 'demo', filePath: 'a.ts', event: 'bound', actor: 'system' });
    const filler = 'x'.repeat(5 * 1024 * 1024 + 10);
    writeFileSync(active, filler, 'utf-8');
    assert.ok(!existsSync(rotated));

    log.record({ project: 'demo', filePath: 'a.ts', event: 'verified', actor: 'system' });

    assert.ok(existsSync(rotated), 'rotated file should exist');
    const after = log.list('demo');
    assert.equal(after.length, 1);
    assert.equal(after[0]!.event, 'verified');
  });

  it('tail(n) returns the last n entries in file order', () => {
    for (let i = 0; i < 10; i++) {
      log.record({
        project: 'demo',
        filePath: `t${i}.ts`,
        event: 'bound',
        actor: 'system',
      });
    }
    const last3 = log.tail('demo', 3);
    assert.equal(last3.length, 3);
    assert.equal(last3[0]!.filePath, 't7.ts');
    assert.equal(last3[1]!.filePath, 't8.ts');
    assert.equal(last3[2]!.filePath, 't9.ts');
  });

  it('skips malformed lines and still returns valid entries', () => {
    log.record({ project: 'demo', filePath: 'a.ts', event: 'bound', actor: 'system' });
    const path = join(home, 'bound-tests-audit', 'demo', 'audit.log');
    appendFileSync(path, '{not json\n', 'utf-8');
    log.record({ project: 'demo', filePath: 'a.ts', event: 'verified', actor: 'bob' });

    const all = log.list('demo');
    assert.equal(all.length, 2);
    assert.equal(all[0]!.event, 'bound');
    assert.equal(all[1]!.event, 'verified');
  });
});
