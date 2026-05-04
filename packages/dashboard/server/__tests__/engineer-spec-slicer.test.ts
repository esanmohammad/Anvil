/**
 * Tests for engineer-spec-slicer.
 *
 * Uses node:test + node:assert (built-in runner), matching the style of the
 * other tests in this directory. Run via:
 *   node --test packages/dashboard/server/__tests__/engineer-spec-slicer.test.ts
 * (after tsc compile, or via a ts loader).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseSections,
  findSection,
  sliceSpecForRefs,
} from '../engineer-spec-slicer.js';

// ── Fixtures ─────────────────────────────────────────────────────────────

const SIMPLE_SPEC = [
  '# Technical Specification',
  '',
  '## Overview',
  '',
  'This is the overview paragraph for the booking feature.',
  '',
  '## Data Model',
  '',
  'Top-level data model description.',
  '',
  '### `src/types.ts` — New Interfaces',
  '',
  'Three interfaces are appended to the existing file.',
  '',
  '### `src/constants/trips.ts` — New File',
  '',
  'Trip data array.',
  '',
  '## Component Design',
  '',
  'High-level component design.',
  '',
  '### `BookingPage.tsx` — Container',
  '',
  'The wizard container component.',
  '',
  '## ADR-002: pricePerPerson as Number (not string)',
  '',
  'We chose number because of arithmetic needs.',
  '',
].join('\n');

const SPEC_WITH_FENCED_HASHES = [
  '## Real Heading',
  '',
  'Some prose.',
  '',
  '```bash',
  '# This is a shell comment, not a heading',
  '## Also a shell comment, ignore',
  '### Triple-hash too',
  '```',
  '',
  '## After Code Block',
  '',
  'Text after.',
  '',
].join('\n');

// ── parseSections ────────────────────────────────────────────────────────

describe('parseSections', () => {
  it('picks up heading levels, multiple sections, and bounds bodies correctly', () => {
    const sections = parseSections(SIMPLE_SPEC);

    // Headings collected: Overview, Data Model, types.ts, trips.ts,
    // Component Design, BookingPage.tsx, ADR-002 (7 total).
    assert.equal(sections.length, 7);

    const overview = sections[0];
    assert.ok(overview);
    assert.equal(overview.heading, 'Overview');
    assert.equal(overview.level, 2);
    assert.match(overview.body, /^## Overview/);
    assert.match(overview.body, /overview paragraph/);
    // Overview body must NOT spill into Data Model.
    assert.ok(!overview.body.includes('## Data Model'));

    const dataModel = sections[1];
    assert.ok(dataModel);
    assert.equal(dataModel.heading, 'Data Model');
    assert.equal(dataModel.level, 2);
    // Data Model is a level-2; its body extends through its level-3 children.
    assert.ok(dataModel.body.includes('### `src/types.ts` — New Interfaces'));
    assert.ok(dataModel.body.includes('### `src/constants/trips.ts` — New File'));
    assert.ok(!dataModel.body.includes('## Component Design'));

    const typesSub = sections[2];
    assert.ok(typesSub);
    assert.equal(typesSub.level, 3);
    assert.match(typesSub.heading, /types\.ts/);
    // Sub-section body stops at the next sibling (## or ###).
    assert.ok(typesSub.body.includes('Three interfaces'));
    assert.ok(!typesSub.body.includes('Trip data array'));
  });

  it('records 1-indexed line numbers for each heading', () => {
    const sections = parseSections(SIMPLE_SPEC);
    const overview = sections.find((s) => s.heading === 'Overview');
    assert.ok(overview);
    // "## Overview" is on line 3 (1-indexed) in SIMPLE_SPEC.
    assert.equal(overview.lineStart, 3);
  });

  it('does not treat `#` inside a fenced code block as a heading', () => {
    const sections = parseSections(SPEC_WITH_FENCED_HASHES);
    // Should only find "Real Heading" and "After Code Block".
    assert.equal(sections.length, 2);
    const first = sections[0];
    const second = sections[1];
    assert.ok(first);
    assert.ok(second);
    assert.equal(first.heading, 'Real Heading');
    assert.equal(second.heading, 'After Code Block');
    // The first heading's body must include the fenced shell comments verbatim.
    assert.ok(first.body.includes('# This is a shell comment'));
    assert.ok(first.body.includes('### Triple-hash too'));
  });
});

// ── findSection ──────────────────────────────────────────────────────────

describe('findSection', () => {
  it('matches an exact normalized heading', () => {
    const s = findSection(SIMPLE_SPEC, 'Data Model');
    assert.ok(s, 'expected a match');
    assert.equal(s.heading, 'Data Model');
    assert.equal(s.level, 2);
  });

  it('matches the last "›"-separated segment', () => {
    const ref = 'Data Model › `src/types.ts` — New Interfaces';
    const s = findSection(SIMPLE_SPEC, ref);
    assert.ok(s, 'expected a match');
    assert.match(s.heading, /types\.ts/);
    assert.match(s.heading, /New Interfaces/);
  });

  it('falls back to a substring match when neither exact nor segment match', () => {
    // The heading is "ADR-002: pricePerPerson as Number (not string)".
    // The ref is a tighter substring.
    const ref = 'pricePerPerson as Number';
    const s = findSection(SIMPLE_SPEC, ref);
    assert.ok(s, 'expected a substring match');
    assert.match(s.heading, /ADR-002/);
  });

  it('falls back to token-overlap for fuzzy refs', () => {
    // Heading: "ADR-002: pricePerPerson as Number (not string)"
    // Fuzzy ref reorders + drops some words but shares >= 60% of significant tokens.
    const ref = 'priceperperson number string adr';
    const s = findSection(SIMPLE_SPEC, ref);
    assert.ok(s, 'expected token-overlap match');
    assert.match(s.heading, /ADR-002/);
  });

  it('returns null when nothing matches', () => {
    const s = findSection(SIMPLE_SPEC, 'totally unrelated kubernetes operator');
    assert.equal(s, null);
  });
});

// ── sliceSpecForRefs ─────────────────────────────────────────────────────

describe('sliceSpecForRefs', () => {
  it('builds a slice for multiple refs and deduplicates repeated sections', () => {
    const refs = [
      'Data Model › `src/types.ts` — New Interfaces',
      'Component Design › `BookingPage.tsx` — Container',
      // Duplicate of the first ref, just slightly different shape — should dedup.
      '`src/types.ts` — New Interfaces',
    ];
    const result = sliceSpecForRefs(SIMPLE_SPEC, refs, { includeOverview: false });

    assert.equal(result.resolved.length, 3);
    assert.equal(result.unresolved.length, 0);
    // Two unique sections survived dedup.
    const sectionCount = (result.text.match(/^### /gm) ?? []).length;
    assert.equal(sectionCount, 2);
    assert.match(result.text, /^## Spec slice \(2 sections\)/);
    assert.ok(result.bytes > 0);
    assert.ok(result.text.includes('types.ts'));
    assert.ok(result.text.includes('BookingPage.tsx'));
  });

  it('reports unresolved refs separately', () => {
    const refs = [
      'Data Model',
      'No Such Section In The Doc Whatsoever',
    ];
    const result = sliceSpecForRefs(SIMPLE_SPEC, refs, { includeOverview: false });

    assert.deepEqual(result.resolved, ['Data Model']);
    assert.deepEqual(result.unresolved, ['No Such Section In The Doc Whatsoever']);
    assert.match(result.text, /## Data Model/);
  });

  it('drops trailing sections to honour maxBytes (no mid-section truncation)', () => {
    // Build a spec with three medium-sized sections.
    const big = (label: string) =>
      `## ${label}\n\n${'x'.repeat(500)}\n`;
    const spec = [big('Alpha'), big('Beta'), big('Gamma')].join('\n');

    const refs = ['Alpha', 'Beta', 'Gamma'];
    // Pick a maxBytes that fits two sections + header but not three.
    const result = sliceSpecForRefs(spec, refs, {
      maxBytes: 1300,
      includeOverview: false,
    });

    assert.equal(result.resolved.length, 3);
    // Only the first two sections fit; the trailing one is dropped.
    assert.match(result.text, /## Alpha/);
    assert.match(result.text, /## Beta/);
    assert.ok(!result.text.includes('## Gamma'), 'Gamma should have been dropped');
    assert.match(result.text, /^## Spec slice \(2 sections\)/);
    // No section was split mid-body — every kept section keeps its full payload.
    const xCount = (result.text.match(/x/g) ?? []).length;
    assert.equal(xCount, 1000);
    assert.ok(result.bytes <= 1300);
  });

  it('includes the Overview section by default when not already in the slice', () => {
    const refs = ['Data Model'];
    const result = sliceSpecForRefs(SIMPLE_SPEC, refs);

    // Overview must show up even though the caller didn't request it.
    assert.match(result.text, /## Overview/);
    assert.match(result.text, /## Data Model/);
    // Resolved should still only contain the explicitly-requested ref.
    assert.deepEqual(result.resolved, ['Data Model']);
    assert.match(result.text, /^## Spec slice \(2 sections\)/);
  });

  it('returns an empty result when no refs resolve', () => {
    const result = sliceSpecForRefs(SIMPLE_SPEC, ['nope', 'still nope'], {
      includeOverview: false,
    });
    assert.equal(result.text, '');
    assert.equal(result.bytes, 0);
    assert.equal(result.resolved.length, 0);
    assert.equal(result.unresolved.length, 2);
  });
});
