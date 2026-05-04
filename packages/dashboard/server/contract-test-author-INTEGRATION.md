# Contract Guard Phase 3 — Integration notes

Phase 3 turns a breaking `ContractDiff` + its affected consumers into real
test source code the consumer team can merge. Nothing below is auto-wired yet.

## Files

- `contract-test-scenarios.ts` — `expandScenarios(change)` → 1–3
  `ContractTestScenario` objects (happy-path first).
- `contract-test-author.ts` — `authorContractTest({ contract, consumerRepo,
  consumerLanguage, endpointId, scenarios, framework? })` →
  `AuthoredContractTest` (filePath, sourceCode, header).
- `contract-test-writer.ts` — `writeContractTests(repoPath, tests, { dryRun,
  overwrite })` → `WrittenTest[]`. Atomic (tmp + rename). Preserves files
  without the anvil-contract header unless `overwrite: true`.
- `contract-test-runner.ts` — `runContractTests({ repoLocalPath, framework,
  filterPath? })` (default `filterPath: 'contract/'`) → aggregate counts.

## How the pieces compose

```
ContractChange[]  —expandScenarios→  ContractTestScenario[]
                                          │
    Contract + endpointId + consumerLang  │
                   │                      │
                   └──── authorContractTest → AuthoredContractTest
                                          │
       repoLocalPath ─── writeContractTests → WrittenTest[]
                                          │
                       runContractTests  ←─┘ (optional smoke run)
```

## Wiring the WS action (dashboard-server.ts)

Add action `generate-contract-tests`:
- Params: `{ projectSlug, diff: ContractDiff, consumers: Array<{ repoPath,
  language, endpointId }>, dryRun?: boolean }`.
- Per consumer, for each breaking change in `diff.changes` call
  `expandScenarios` → `authorContractTest` (auto-detect framework), then
  `writeContractTests(repoPath, tests, { dryRun })`.
- Respond with `{ written: WrittenTest[], runnable: boolean }`.

A follow-up action `run-contract-tests` takes `{ repoPath, framework }` and
returns the `ContractRunResult` unchanged.

## Safe re-generation

`writeContractTests` detects hand edits by looking for the
`anvil-contract` marker in the file's first four lines (`//` for
ts/js/go/java, `#` for python). A file without the marker is preserved
(WrittenTest.skipped=true, reason `"hand-edited"`) unless the caller passes
`overwrite: true`. This keeps the "regenerate on every diff" workflow safe
against manual edits in consumer repos.

## Framework detection assumptions

`authorContractTest` picks a default framework from the consumer language
(ts/js → vitest, py → pytest, go → go-test, java → junit). Callers can
override via the explicit `framework` field — useful when a consumer repo
uses jest or mocha instead of vitest.
