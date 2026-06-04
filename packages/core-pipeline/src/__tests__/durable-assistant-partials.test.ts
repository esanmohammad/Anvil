/**
 * H2 — assistant-partial persistence (v2 ADR §2.2).
 *
 * Runs the SAME fixtures against BOTH drivers (in-memory + sqlite) so
 * the bit-identical contract is enforced, mirroring the existing
 * in-memory/sqlite store test pairing. Covers:
 *   - append + read round-trip, payload integrity
 *   - per-(run,step,turn) monotonic seq
 *   - read-by-turn vs read-by-step (across turns)
 *   - invalidation tombstones at three precision levels
 *   - readAssistantPartials excludes tombstoned rows
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { InMemoryDurableStore } from '../durable/in-memory-store.js';
import { SQLiteDurableStore } from '../durable/sqlite-store.js';
import type { DurableStore } from '../durable/store.js';

const newRun = (runId = 'run-1') => ({ runId, project: 'p', feature: 'f', featureSlug: 'f' });

/** Build the two drivers; sqlite gets a throwaway temp file. */
interface Driver { name: string; make: () => DurableStore; cleanup?: () => void; }

const drivers: Driver[] = [
  { name: 'in-memory', make: () => new InMemoryDurableStore() },
];

// sqlite driver depends on better-sqlite3 being installed; guard so the
// suite still runs in environments without it.
let sqliteDir: string | null = null;
try {
  sqliteDir = mkdtempSync(join(tmpdir(), 'anvil-partials-sqlite-'));
  let n = 0;
  drivers.push({
    name: 'sqlite',
    make: () => new SQLiteDurableStore({ path: join(sqliteDir!, `db-${n++}.sqlite`) }),
    cleanup: () => { if (sqliteDir) rmSync(sqliteDir, { recursive: true, force: true }); },
  });
} catch {
  // better-sqlite3 unavailable — in-memory coverage still runs.
}

after(() => {
  for (const d of drivers) d.cleanup?.();
});

for (const driver of drivers) {
  describe(`assistant-partials — ${driver.name}`, () => {
    const mk = async (): Promise<DurableStore> => {
      const store = driver.make();
      await store.createRun(newRun());
      return store;
    };

    it('appends and reads back a partial with payload intact', async () => {
      const store = await mk();
      const rec = await store.appendAssistantPartial({
        runId: 'run-1', stepId: 'build', turnUuid: 't1',
        payload: { text: 'hello', toolUsesEmitted: 0, reason: 'upstream' },
      });
      assert.equal(rec.seq, 1);
      assert.equal(rec.invalidated, false);
      assert.ok(rec.partialId);

      const read = await store.readAssistantPartials('run-1', 'build', 't1');
      assert.equal(read.length, 1);
      assert.deepEqual(read[0].payload, { text: 'hello', toolUsesEmitted: 0, reason: 'upstream' });
      await store.close();
    });

    it('assigns monotonic per-(run,step,turn) seq', async () => {
      const store = await mk();
      const a = await store.appendAssistantPartial({ runId: 'run-1', stepId: 'build', turnUuid: 't1', payload: { text: 'a' } });
      const b = await store.appendAssistantPartial({ runId: 'run-1', stepId: 'build', turnUuid: 't1', payload: { text: 'b' } });
      // Different turn restarts seq at 1.
      const c = await store.appendAssistantPartial({ runId: 'run-1', stepId: 'build', turnUuid: 't2', payload: { text: 'c' } });
      assert.equal(a.seq, 1);
      assert.equal(b.seq, 2);
      assert.equal(c.seq, 1);
      await store.close();
    });

    it('read-by-step returns partials across turns in global-recency order', async () => {
      const store = await mk();
      await store.appendAssistantPartial({ runId: 'run-1', stepId: 'build', turnUuid: 't1', payload: { text: 'first' } });
      await store.appendAssistantPartial({ runId: 'run-1', stepId: 'build', turnUuid: 't2', payload: { text: 'second' } });
      const all = await store.readAssistantPartials('run-1', 'build');
      assert.equal(all.length, 2);
      // Caller takes the LAST as the most recent.
      assert.deepEqual(all[all.length - 1].payload, { text: 'second' });
      await store.close();
    });

    it('scopes reads by stepId', async () => {
      const store = await mk();
      await store.appendAssistantPartial({ runId: 'run-1', stepId: 'build', turnUuid: 't1', payload: { text: 'b' } });
      await store.appendAssistantPartial({ runId: 'run-1', stepId: 'validate', turnUuid: 't1', payload: { text: 'v' } });
      const build = await store.readAssistantPartials('run-1', 'build');
      assert.equal(build.length, 1);
      assert.deepEqual(build[0].payload, { text: 'b' });
      await store.close();
    });

    it('invalidatePartials(run, step, turn) tombstones only that turn', async () => {
      const store = await mk();
      await store.appendAssistantPartial({ runId: 'run-1', stepId: 'build', turnUuid: 't1', payload: { text: 'a' } });
      await store.appendAssistantPartial({ runId: 'run-1', stepId: 'build', turnUuid: 't2', payload: { text: 'b' } });
      await store.invalidatePartials('run-1', 'build', 't1');
      assert.equal((await store.readAssistantPartials('run-1', 'build', 't1')).length, 0);
      assert.equal((await store.readAssistantPartials('run-1', 'build', 't2')).length, 1);
      await store.close();
    });

    it('invalidatePartials(run, step) tombstones the whole step', async () => {
      const store = await mk();
      await store.appendAssistantPartial({ runId: 'run-1', stepId: 'build', turnUuid: 't1', payload: { text: 'a' } });
      await store.appendAssistantPartial({ runId: 'run-1', stepId: 'build', turnUuid: 't2', payload: { text: 'b' } });
      await store.invalidatePartials('run-1', 'build');
      assert.equal((await store.readAssistantPartials('run-1', 'build')).length, 0);
      await store.close();
    });

    it('invalidatePartials(run) tombstones every step', async () => {
      const store = await mk();
      await store.appendAssistantPartial({ runId: 'run-1', stepId: 'build', turnUuid: 't1', payload: { text: 'a' } });
      await store.appendAssistantPartial({ runId: 'run-1', stepId: 'validate', turnUuid: 't1', payload: { text: 'v' } });
      await store.invalidatePartials('run-1');
      assert.equal((await store.readAssistantPartials('run-1', 'build')).length, 0);
      assert.equal((await store.readAssistantPartials('run-1', 'validate')).length, 0);
      await store.close();
    });
  });
}
