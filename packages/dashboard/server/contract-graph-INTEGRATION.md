# Contract Guard Phase 2 — Integration notes

Phase 2 ships consumer detection + graph building + impact analysis. Nothing
below has been wired up yet.

## Files

- `contract-consumer-detector.ts` — `detectConsumerCalls(repoLocalPath, repoName, opts?)`.
- `contract-graph-builder.ts` — `buildContractGraph(contracts, calls)`.
- `contract-impact-analyzer.ts` — `analyzeContractImpact(diff, graph)`.

## Composing with Phase 1

```ts
import { discoverContracts } from './contract-discovery.js';
import { diffContracts } from './contract-differ.js';
import { detectConsumerCalls } from './contract-consumer-detector.js';
import { buildContractGraph } from './contract-graph-builder.js';
import { analyzeContractImpact } from './contract-impact-analyzer.js';

const contracts = repos.flatMap((r) => discoverContracts(r.localPath, r.name));
const calls     = repos.flatMap((r) => detectConsumerCalls(r.localPath, r.name));
const graph     = buildContractGraph(contracts, calls);
const diff      = diffContracts(beforeContract, afterContract);
const report    = analyzeContractImpact(diff, graph);
```

## Wiring into the dashboard

Two new WS actions are expected (both read-only, gated by the same project-scope
permission as `list-contracts`):

- `contract-graph` — params `{ projectSlug }`. Returns `{ contracts, edges, orphans }`
  (drop `calls` from the wire payload to keep it small).
- `contract-impact` — params `{ projectSlug, before, after }`. Returns an
  `ImpactReport`.

## Caching & incremental re-detection

- Persist `ContractGraph` alongside the KB refresh output keyed by project slug.
  Re-run `detectConsumerCalls` on a file-change signal (watch or polling) by
  invalidating only the affected `repoName` slice and concatenating the new
  results with the untouched ones before re-building.
- `buildContractGraph` is pure — safe to re-run on every diff request with a
  cached `calls` array.
- For large monorepos, lower `maxFiles` (default 5000) per repo and raise it
  only for producer-adjacent directories.

## Known limitations (Phase 2)

- Regex-level detection: dynamic URLs (`fetch(baseUrl + path)`) are captured
  only when the string literal is on the same line.
- Java okhttp verb detection is weak — `.url(...)` is reported as `GET` unless
  the request builder is inlined with `.post(...)`/`.put(...)` on the same line.
- GraphQL matching is best-effort on operation names; no schema-aware field
  resolution.
- gRPC matching requires the proto endpoint id to end with the method name
  (`service.v1.X/MethodName`).
