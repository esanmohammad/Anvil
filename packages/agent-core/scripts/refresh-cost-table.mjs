#!/usr/bin/env node
/**
 * Refresh the vendored cost table snapshot.
 *
 * Pulls LiteLLM's `model_prices_and_context_window.json` (Apache-2.0) and
 * writes it to `packages/agent-core/src/data/model-prices.json`. The snapshot
 * is committed to the repo — there is no runtime fetch.
 *
 * Run cadence: quarterly + when adding a new model. The snapshot is small
 * (~150 KB) and the source is stable, so manual refresh is fine.
 *
 * Usage:
 *   node packages/agent-core/scripts/refresh-cost-table.mjs
 *
 * License: the upstream JSON is Apache-2.0. Our copy is governed by the same
 * license. See https://github.com/BerriAI/litellm/blob/main/LICENSE for terms.
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const URL = 'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';
const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT = join(__dirname, '..', 'src', 'data', 'model-prices.json');

console.log(`[refresh-cost-table] fetching ${URL}`);
const res = await fetch(URL);
if (!res.ok) {
  console.error(`[refresh-cost-table] FAIL ${res.status} ${res.statusText}`);
  process.exit(1);
}
const text = await res.text();

// Validate it's parseable JSON before writing.
try {
  const parsed = JSON.parse(text);
  const keys = Object.keys(parsed);
  console.log(`[refresh-cost-table] received ${keys.length} model entries (${(text.length / 1024).toFixed(1)} KB)`);
} catch (err) {
  console.error('[refresh-cost-table] FAIL: response is not valid JSON');
  console.error(err.message);
  process.exit(1);
}

writeFileSync(OUT, text);
console.log(`[refresh-cost-table] wrote ${OUT}`);
