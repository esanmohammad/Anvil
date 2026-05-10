/**
 * H10-followup #8 — real Playwright integration smoke test. Skipped
 * when `playwright` isn't installed so the dashboard test suite stays
 * runnable on machines that opted out of Tier 2.
 *
 * Set ANVIL_RUN_PLAYWRIGHT_TESTS=1 to actually exercise this. The
 * default-skipped behavior keeps CI green when Chromium isn't present.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createPlaywrightRunner } from '../browser/playwright-runner.js';

const ENABLED = process.env.ANVIL_RUN_PLAYWRIGHT_TESTS === '1';

describe('Playwright runner — real browser smoke', { skip: !ENABLED }, () => {
  it('navigates to a local data: URL and serializes the body', async () => {
    const root = mkdtempSync(join(tmpdir(), 'anvil-pw-'));
    try {
      // Write a tiny HTML file we can navigate to via file:// — avoids
      // any network dependency.
      const htmlPath = join(root, 'page.html');
      writeFileSync(
        htmlPath,
        '<!doctype html><html><head><title>Hello</title></head>' +
        '<body><h1>Hello world</h1><button id="btn">Click</button></body></html>',
      );
      const runner = await createPlaywrightRunner({
        runId: 'pw-test', sessionId: 's0', userDataDir: root, headless: true,
      });
      try {
        const snap = await runner.navigate({ url: `file://${htmlPath}` });
        assert.match(snap.title, /Hello/);
        assert.ok(snap.url.endsWith('page.html'));
        const buttonNode = snap.domRoot.children?.find((n) =>
          n.tag === 'body'
            ? n.children?.some((c) => c.tag === 'button')
            : n.tag === 'button',
        );
        assert.ok(buttonNode, 'expected button in snapshot');
      } finally {
        await runner.close();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
