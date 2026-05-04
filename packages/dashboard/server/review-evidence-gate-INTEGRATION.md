# Review Evidence Gate (R2) — Integration

## Where to call `applyEvidenceGate`

In `review-publisher.ts` (or the persona-orchestration entry point that feeds
`ReviewStore.appendFindings`), call `applyEvidenceGate` **after** all personas
have emitted their `ReviewFinding[]` and **before** the findings are written
to `ReviewStore`.

Conceptual call site:

```ts
import { applyEvidenceGate } from './review-evidence-gate.js';
import type { EnrichedFinding } from './review-finding-extensions.js';

// 1. Collect from personas
const raw: EnrichedFinding[] = [...architectFindings, ...securityFindings, ...];

// 2. Gate
const { kept, dropped } = await applyEvidenceGate(raw, {
  repoLocalPath,
  diffText,
  fileContents,        // { [repoRelPath]: string }
  astGraph,            // optional
});

// 3. Persist only `kept`; `dropped` goes to the audit log only.
reviewStore.appendFindings(project, reviewId, kept);
```

## Extending `ReviewFinding`

`review-finding-extensions.ts` defines `ExtendedFindingFields` and
`EnrichedFinding = ReviewFinding & ExtendedFindingFields`. The evidence gate
and downstream calibration phases accept `EnrichedFinding`. Integration should:

1. Merge `ExtendedFindingFields` into the canonical `ReviewFinding` interface
   in `review-store.ts` (all fields are optional, so this is backward-compat).
2. Update persona emitters to populate `claimType`, `quoted`, `targetSymbol`,
   `assumedPrecondition`, and `statedConfidence` when applicable.
3. Keep `evidenceChecks[]`, `demoted`, `immutable`, `proposedPatch`, and
   `calibratedConfidence` as gate/calibrator-owned fields.

## Tooling behavior

- `type-check` (tsc/pyright/mypy/go vet) skips cleanly when the binary is not
  installed (`ENOENT`) or no `tsconfig.json` exists — `passed: true` with a
  `skipped:` detail. No drops occur from missing tooling.
- `precedent-check`, `symbol-check`, and `test-exists-check` bound their walks
  (skip `node_modules`, `dist`, `.git`, cap file size/count).
- `caller-contract-check` requires an optional `astGraph` with a `callersOf`
  method; otherwise it is skipped.
