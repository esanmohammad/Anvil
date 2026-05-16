/**
 * stripVolatile — recursively normalize volatile fields in event payloads
 * before snapshot comparison. Without this, snapshots would churn on every
 * run (timestamps, run ids, ports, tmp paths all change).
 *
 * Substitutions:
 *   ISO timestamp                  → '<TS>'
 *   epoch ms timestamp (≥ 10^12)   → '<TS_MS>'
 *   run-<hex>                      → 'run-<ID>'
 *   agent-<hex>                    → 'agent-<ID>'
 *   ws://localhost:<n>             → 'ws://localhost:<PORT>'
 *   http://localhost:<n>           → 'http://localhost:<PORT>'
 *   /tmp/.../anvil-<tag>-<...>     → '<ANVIL_HOME>'
 *
 * Recursion walks plain objects + arrays only. Leaves are coerced
 * via String() then matched against the patterns above.
 */

const RX_ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
// Match agent / run ids strictly — fake ids look like "agent-fake-00000001";
// real ids are UUIDs (`-` separated hex). Be careful NOT to swallow event
// types like "agent-spawned" / "agent-output" / "run-stopped" / "run-rejected"
// which start with the same prefix but have non-hex suffixes.
//
// Requirement: at least 8 chars after the prefix, all hex + dashes only.
const RX_AGENT_ID = /^agent-(?:fake-)?[a-f0-9][a-f0-9-]{7,}$/i;
const RX_RUN_ID = /^run-(?:fake-)?[a-f0-9][a-f0-9-]{7,}$/i;

const URL_PATTERNS: Array<[RegExp, string]> = [
  [/\bws:\/\/localhost:\d+\b/g, 'ws://localhost:<PORT>'],
  [/\bhttp:\/\/localhost:\d+\b/g, 'http://localhost:<PORT>'],
];

const TMP_HOME_PATTERN = /\/(?:private\/)?(?:tmp|var\/folders)\/[^"'\s]*?anvil-[a-z0-9-]+/g;

export function stripVolatile(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === 'number') {
    // Epoch ms timestamps land in this range; bare numbers (e.g. counts) stay as-is.
    if (Number.isInteger(value) && value >= 1_000_000_000_000) return '<TS_MS>';
    return value;
  }

  if (typeof value === 'string') return normaliseString(value);

  if (Array.isArray(value)) return value.map(stripVolatile);

  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      // Drop completely random side-effects keyed by run/agent id.
      out[k] = stripVolatile(v);
    }
    return out;
  }

  return value;
}

function normaliseString(s: string): string {
  if (RX_ISO_TS.test(s)) return '<TS>';
  if (RX_RUN_ID.test(s)) return 'run-<ID>';
  if (RX_AGENT_ID.test(s)) return 'agent-<ID>';

  let out = s;
  for (const [rx, replacement] of URL_PATTERNS) out = out.replace(rx, replacement);
  out = out.replace(TMP_HOME_PATTERN, '<ANVIL_HOME>');
  return out;
}
