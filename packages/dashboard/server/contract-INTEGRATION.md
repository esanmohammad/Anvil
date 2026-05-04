# Contract Guard Phase 1 — Integration notes

Phase 1 ships the schema discovery, parsing, and diff engine only. Nothing
below has been wired up yet.

## Files

- `contract-types.ts` — shared `Contract`, `ContractChange`, `ContractDiff`.
- `contract-discovery.ts` — `discoverContracts(repoLocalPath, repoName)`.
- `contract-parser.ts` — `parseOpenapi`, `parseProto`, `parseGraphql`,
  `parseJsonSchema`, `parseAvro`, plus the unified `parseContract`.
- `contract-differ.ts` — `diffContracts(before, after)`.

## Wiring the WS actions (dashboard-server.ts)

Two new actions are expected:

- `list-contracts` — params `{ projectSlug }`. Resolves the project's local
  repo paths (same resolver the KB refresh uses), runs `discoverContracts` per
  repo, returns `{ contracts: Contract[] }`.
- `diff-contracts` — params `{ before: Contract; after: Contract }` or
  `{ projectSlug; sourceFile; beforeRef; afterRef }`. Returns `ContractDiff`.

Both actions should be read-only and gated by the existing project-scope
permission check used by the KB endpoints.

## Where to call `discoverContracts`

1. At the end of each **knowledge-base refresh** (next to the convention
   fingerprinter). Persist the result on the project store so later diffs
   don't have to re-walk.
2. On **manual trigger** from the dashboard ("Scan contracts" button), which
   maps to the `list-contracts` action above.

## Known limitations (Phase 1)

- Proto `import` statements are not resolved across files.
- JSON Schema `$ref` is resolved one level deep (local `#/definitions/*` only).
- Avro is a stub (top-level `name` + `fields` only).
- GraphQL interfaces / unions are not modeled.
