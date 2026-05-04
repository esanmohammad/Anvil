/**
 * contract-test-scenarios — expand a ContractChange into concrete test
 * scenarios that consumer repos can use to guard against the break.
 */

import type { ContractChange } from './contract-types.js';

// ── Public types ────────────────────────────────────────────────────────

export type ScenarioKind =
  | 'happy-path'
  | 'removed-field'
  | 'narrowed-type'
  | 'error-path';

export interface ContractTestScenario {
  change: ContractChange;
  kind: ScenarioKind;
  /** Human-friendly test name, suitable as an `it()` title. */
  name: string;
  description: string;
  /**
   * Minimal sample payload conforming to the BEFORE contract (so the test
   * asserts the OLD shape still matches, which is what consumers need).
   */
  requestPayload?: unknown;
  /** Minimal sample response shape the consumer still expects to see. */
  expectedResponseShape?: unknown;
}

// ── Entry point ─────────────────────────────────────────────────────────

/**
 * Expand a single ContractChange into 1–3 scenarios. The first scenario is
 * always the happy-path assertion (the contract still holds its pre-break
 * shape). Additional scenarios probe the specific break mode (removed field,
 * narrowed type, vanished endpoint, etc.).
 */
export function expandScenarios(change: ContractChange): ContractTestScenario[] {
  const scenarios: ContractTestScenario[] = [happyPath(change)];

  switch (change.kind) {
    case 'field-removed': {
      scenarios.push({
        change,
        kind: 'removed-field',
        name: `should still expose ${change.path}`,
        description:
          `The before-contract had ${change.path}; consumers depend on it. ` +
          'This test asserts the field is present and non-undefined.',
        expectedResponseShape: { [fieldBasename(change.path)]: samplePrimitive(change.before) },
      });
      break;
    }

    case 'required-added': {
      scenarios.push({
        change,
        kind: 'removed-field',
        name: `should accept payload without new required ${change.path}`,
        description:
          `After the change ${change.path} is required, breaking callers that ` +
          'omit it. This test replays the previous-shape request.',
        requestPayload: omitPath(change.path),
      });
      break;
    }

    case 'required-removed': {
      scenarios.push({
        change,
        kind: 'removed-field',
        name: `should still require ${change.path}`,
        description:
          `${change.path} used to be required; consumers may skip null-checks. ` +
          'This test asserts the field is present in the response shape.',
        expectedResponseShape: { [fieldBasename(change.path)]: samplePrimitive(change.before) },
      });
      break;
    }

    case 'type-narrowed': {
      scenarios.push({
        change,
        kind: 'narrowed-type',
        name: `should accept ${change.path} as ${change.before ?? 'previous type'}`,
        description:
          `Type narrowed from ${change.before ?? '?'} to ${change.after ?? '?'}. ` +
          'This test sends a value matching the wider BEFORE type.',
        requestPayload: { [fieldBasename(change.path)]: samplePrimitive(change.before) },
      });
      scenarios.push({
        change,
        kind: 'error-path',
        name: `should reject values outside ${change.after ?? 'new type'} with a typed error`,
        description:
          'When the server returns an error for a now-invalid value, consumers ' +
          'must still get a structured response (not a 500).',
      });
      break;
    }

    case 'type-widened': {
      scenarios.push({
        change,
        kind: 'narrowed-type',
        name: `should still accept ${change.path} as ${change.before ?? 'previous type'}`,
        description:
          `Type widened from ${change.before ?? '?'} to ${change.after ?? '?'}. ` +
          'Consumers should keep working with the narrower BEFORE shape.',
        requestPayload: { [fieldBasename(change.path)]: samplePrimitive(change.before) },
      });
      break;
    }

    case 'enum-shrunk': {
      scenarios.push({
        change,
        kind: 'narrowed-type',
        name: `should accept previously-valid enum value for ${change.path}`,
        description:
          `Enum shrunk: ${change.before ?? '?'} -> ${change.after ?? '?'}. ` +
          'A removed value is the most common consumer break.',
        requestPayload: { [fieldBasename(change.path)]: firstEnumValue(change.before) },
      });
      scenarios.push({
        change,
        kind: 'error-path',
        name: `should surface a typed error for removed enum value on ${change.path}`,
        description:
          'If the server now rejects the removed value, the error must be ' +
          'structured (status + message), not a protocol failure.',
      });
      break;
    }

    case 'enum-extended': {
      scenarios.push({
        change,
        kind: 'happy-path',
        name: `should tolerate unknown enum value for ${change.path}`,
        description:
          'Enum was extended. Consumers must not crash on the new value. ' +
          'This test sends a previously-unknown token.',
        requestPayload: { [fieldBasename(change.path)]: firstEnumValue(change.after) },
      });
      break;
    }

    case 'endpoint-removed': {
      scenarios.push({
        change,
        kind: 'error-path',
        name: `should still route ${change.path}`,
        description:
          `Endpoint ${change.path} was removed. Consumers calling it must get ` +
          'a clear 404/410, not a protocol-level failure.',
      });
      break;
    }

    case 'response-shape-changed': {
      scenarios.push({
        change,
        kind: 'narrowed-type',
        name: `response for ${change.path} should still match previous shape`,
        description:
          `The response shape for ${change.path} changed. Consumers expect the ` +
          'previous shape to still be present (or gracefully defaulted).',
        expectedResponseShape: samplePrimitive(change.before),
      });
      break;
    }

    case 'request-shape-changed': {
      scenarios.push({
        change,
        kind: 'narrowed-type',
        name: `request for ${change.path} should still accept previous shape`,
        description:
          `The request shape for ${change.path} changed. Callers sending the ` +
          'previous-shape body must still succeed.',
        requestPayload: samplePrimitive(change.before),
      });
      break;
    }

    default:
      // field-added, endpoint-added: no extra scenarios — happy-path suffices.
      break;
  }

  return scenarios;
}

// ── Helpers ─────────────────────────────────────────────────────────────

function happyPath(change: ContractChange): ContractTestScenario {
  return {
    change,
    kind: 'happy-path',
    name: `should still honor ${change.path} (${change.kind})`,
    description:
      `Contract guard: the BEFORE shape at ${change.path} is exercised end-to-end ` +
      'to detect unintended downstream breakage.',
    requestPayload: { [fieldBasename(change.path)]: samplePrimitive(change.before) },
    expectedResponseShape: { [fieldBasename(change.path)]: samplePrimitive(change.before) },
  };
}

function fieldBasename(path: string): string {
  const last = path.split('.').pop() ?? path;
  // Drop any method/path chunks — keep only the leaf identifier.
  return last.replace(/[^\w]/g, '_') || 'value';
}

/**
 * Produce a minimal representative primitive for a declared type. Covers the
 * normalized type strings emitted by `contract-parser.ts`.
 */
function samplePrimitive(type: string | undefined): unknown {
  if (!type) return null;
  const t = type.trim();
  if (/array<(.*)>/i.test(t)) {
    const inner = t.match(/array<(.*)>/i)?.[1] ?? 'string';
    return [samplePrimitive(inner)];
  }
  if (/\bnull\b/.test(t)) return null;
  if (/^(int|integer|int32|int64|long|short)/i.test(t)) return 0;
  if (/^(float|double|number|decimal)/i.test(t)) return 0;
  if (/^(bool|boolean)/i.test(t)) return false;
  if (/^string$/i.test(t)) return 'sample';
  if (/^date/i.test(t)) return '1970-01-01';
  if (/^uuid/i.test(t)) return '00000000-0000-0000-0000-000000000000';
  if (/^object$/i.test(t)) return {};
  // Named type or union — opaque placeholder.
  return { __contract__: t };
}

function firstEnumValue(spec: string | undefined): string {
  if (!spec) return 'value';
  // Enum specs are serialized as `A|B|C`.
  const first = spec.split('|')[0]?.trim();
  return first || 'value';
}

/**
 * Produce a payload that omits the given dotted path — used by `required-added`
 * scenarios to replay a pre-change request body.
 */
function omitPath(path: string): Record<string, unknown> {
  // We only have the leaf name here, so emit an object without it — the
  // template-layer will frame it as "this is what the old caller sent".
  return { __omitted__: path };
}
