/**
 * Tests for review-kb-context (Review Phase R5).
 *
 * Uses node:test + node:assert/strict, matching the conventions of the other
 * suites in this directory. Run via:
 *   node --test packages/dashboard/server/__tests__/review-kb-context.test.ts
 * (after tsc compile, or via a ts loader).
 *
 * No explicit TS type annotations appear inside test bodies — fixtures are
 * plain JS objects so the tests exercise the module's unknown-graph tolerance
 * path the way production will.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeKbContext } from '../review-kb-context.js';

// ── Fixture helpers (intentionally untyped at the call site) ──────────────
//
// Helpers use `unknown[]` / `string` at the signature only — the goal is to
// keep `describe`/`it` bodies free of explicit type annotations so tests
// exercise the module's unknown-narrowing path the way production will.

function makeGraph(nodes: unknown[], links: unknown[]): unknown {
  return { nodes, links };
}

function moduleNode(id: string): unknown {
  return { id, label: id.split('/').pop(), file: id, type: 'module' };
}

function symbolNode(file: string, name: string, extra?: Record<string, unknown>): unknown {
  return {
    id: `${file}::${name}`,
    label: name,
    file,
    type: 'function',
    ...(extra || {}),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('computeKbContext', () => {
  it('empty graph → empty report and orphan entry', () => {
    const report = computeKbContext(
      [{ repoName: 'web', filePath: 'src/pages/BookingPage.tsx' }],
      { web: { nodes: [], links: [] } },
    );
    assert.equal(report.changedSymbols.length, 0);
    assert.equal(report.orphans.length, 1);
    assert.match(report.orphans[0].note, /no indexed graph|no symbols/i);
  });

  it('resolves callers via the reverse-index', () => {
    const file = 'src/pages/BookingPage.tsx';
    const caller1 = 'src/components/SeatPicker.tsx';
    const caller2 = 'src/components/ConfirmModal.tsx';
    const graph = makeGraph(
      [
        moduleNode(file),
        symbolNode(file, 'handleSeatClick'),
        moduleNode(caller1),
        symbolNode(caller1, 'onClick'),
        moduleNode(caller2),
        symbolNode(caller2, 'onConfirm'),
      ],
      [
        { source: file, target: `${file}::handleSeatClick`, type: 'contains' },
        { source: `${caller1}::onClick`, target: `${file}::handleSeatClick`, type: 'calls' },
        { source: `${caller2}::onConfirm`, target: `${file}::handleSeatClick`, type: 'calls' },
      ],
    );

    const report = computeKbContext(
      [{ repoName: 'web', filePath: file, addedSymbols: ['handleSeatClick'] }],
      { web: graph },
    );

    assert.equal(report.changedSymbols.length, 1);
    const sym = report.changedSymbols[0];
    assert.equal(sym.symbol, 'handleSeatClick');
    assert.equal(sym.callers.length, 2);
    const files = sym.callers.map((c) => c.file).sort();
    assert.deepEqual(files, [caller2, caller1].sort());
    // "contains" edges must not pollute caller resolution.
    assert.ok(!sym.callers.some((c) => c.file === file));
  });

  it('resolves callees via the outgoing-index', () => {
    const file = 'src/pages/BookingPage.tsx';
    const util = 'src/utils/logAnalytics.ts';
    const ctx = 'src/context/useBookingContext.ts';
    const graph = makeGraph(
      [
        moduleNode(file),
        symbolNode(file, 'handleSeatClick'),
        moduleNode(util),
        symbolNode(util, 'logAnalytics'),
        moduleNode(ctx),
        symbolNode(ctx, 'useBookingContext'),
      ],
      [
        { source: file, target: `${file}::handleSeatClick`, type: 'contains' },
        { source: `${file}::handleSeatClick`, target: `${util}::logAnalytics`, type: 'calls' },
        { source: `${file}::handleSeatClick`, target: `${ctx}::useBookingContext`, type: 'calls' },
      ],
    );

    const report = computeKbContext(
      [{ repoName: 'web', filePath: file, addedSymbols: ['handleSeatClick'] }],
      { web: graph },
    );

    const sym = report.changedSymbols[0];
    assert.equal(sym.callees.length, 2);
    const contexts = sym.callees.map((c) => c.context).sort();
    assert.deepEqual(contexts, ['logAnalytics', 'useBookingContext']);
  });

  it('detects public API via index.* barrel re-exports and exported metadata', () => {
    // Case A: the node itself carries exported=true.
    const fileA = 'src/lib/formatDate.ts';
    const graphA = makeGraph(
      [
        moduleNode(fileA),
        symbolNode(fileA, 'formatDate', { exported: true }),
      ],
      [{ source: fileA, target: `${fileA}::formatDate`, type: 'contains' }],
    );
    const reportA = computeKbContext(
      [{ repoName: 'ui', filePath: fileA, addedSymbols: ['formatDate'] }],
      { ui: graphA },
    );
    assert.equal(reportA.changedSymbols[0].isPublicApi, true);

    // Case B: no metadata, but an index.ts barrel imports it.
    const fileB = 'src/components/BookingForm/BookingForm.tsx';
    const barrel = 'src/components/BookingForm/index.ts';
    const graphB = makeGraph(
      [
        moduleNode(fileB),
        symbolNode(fileB, 'BookingForm'),
        moduleNode(barrel),
      ],
      [
        { source: fileB, target: `${fileB}::BookingForm`, type: 'contains' },
        { source: barrel, target: `${fileB}::BookingForm`, type: 'imports' },
      ],
    );
    const reportB = computeKbContext(
      [{ repoName: 'ui', filePath: fileB, addedSymbols: ['BookingForm'] }],
      { ui: graphB },
    );
    assert.equal(reportB.changedSymbols[0].isPublicApi, true);

    // Case C: no barrel, no metadata → private.
    const fileC = 'src/internal/helper.ts';
    const graphC = makeGraph(
      [moduleNode(fileC), symbolNode(fileC, 'privateHelper')],
      [{ source: fileC, target: `${fileC}::privateHelper`, type: 'contains' }],
    );
    const reportC = computeKbContext(
      [{ repoName: 'ui', filePath: fileC, addedSymbols: ['privateHelper'] }],
      { ui: graphC },
    );
    assert.equal(reportC.changedSymbols[0].isPublicApi, false);
  });

  it('ripple estimate transitions at the small/medium/large thresholds', () => {
    function buildWithCallers(n: number) {
      const target = 'src/target.ts';
      const nodes = [moduleNode(target), symbolNode(target, 'hot')];
      const links = [{ source: target, target: `${target}::hot`, type: 'contains' }];
      for (let i = 0; i < n; i++) {
        const callerFile = `src/caller-${i}.ts`;
        nodes.push(moduleNode(callerFile));
        nodes.push(symbolNode(callerFile, `fn${i}`));
        links.push({
          source: `${callerFile}::fn${i}`,
          target: `${target}::hot`,
          type: 'calls',
        });
      }
      return { graph: makeGraph(nodes, links), target };
    }

    // 4 callers → small (<5).
    const small = buildWithCallers(4);
    const smallReport = computeKbContext(
      [{ repoName: 'r', filePath: small.target, addedSymbols: ['hot'] }],
      { r: small.graph },
    );
    assert.equal(smallReport.changedSymbols[0].rippleEstimate, 'small');

    // 5 callers → medium (transition).
    const medium = buildWithCallers(5);
    const medReport = computeKbContext(
      [{ repoName: 'r', filePath: medium.target, addedSymbols: ['hot'] }],
      { r: medium.graph },
    );
    assert.equal(medReport.changedSymbols[0].rippleEstimate, 'medium');

    // 19 callers → medium (upper bound of the window).
    const medHigh = buildWithCallers(19);
    const medHighReport = computeKbContext(
      [{ repoName: 'r', filePath: medHigh.target, addedSymbols: ['hot'] }],
      { r: medHigh.graph },
    );
    assert.equal(medHighReport.changedSymbols[0].rippleEstimate, 'medium');

    // 20 callers → large (transition).
    const large = buildWithCallers(20);
    const largeReport = computeKbContext(
      [{ repoName: 'r', filePath: large.target, addedSymbols: ['hot'] }],
      { r: large.graph },
    );
    assert.equal(largeReport.changedSymbols[0].rippleEstimate, 'large');
  });
});
