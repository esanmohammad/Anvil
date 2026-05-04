# Contract Guard Phase 4 — UI + CLI Integration Notes

Phase 4 ships the dashboard UI and CLI surface only. None of the WS/HTTP
handlers below are registered yet — wiring happens in the Phase 5 PR that
touches `dashboard-server.ts`.

## Files

- `src/components/contracts/contract-ui-types.ts` — browser-safe mirrors of
  `Contract`, `ContractChange`, `ImpactReport`.
- `src/components/contracts/useContracts.ts` — React hook: list, select,
  impact, rescan, generate.
- `src/components/contracts/ContractDriftPanel.tsx` — drift + impact view.
- `src/components/contracts/ContractsMapPage.tsx` — two-pane map page.
- `cli/src/commands/contracts.ts` — `anvil contracts {list,drift,generate,verify}`.

## WebSocket actions (consumed by `useContracts`)

| Client → Server               | Server → Client (type)        | Payload                                                             |
| ----------------------------- | ----------------------------- | ------------------------------------------------------------------- |
| `list-contracts`              | `contracts-list`              | `{ project, contracts: ContractSummary[] }`                         |
| `select-contract`             | `contract-selected`           | `{ project, sourceFile, repoName, impact: ImpactReport }`           |
| `rescan-contracts`            | `contracts-list`              | same as `list-contracts`                                            |
| `generate-contract-tests`     | `contract-tests-generated`    | `{ project, writtenFiles: string[], skipped: string[] }`            |
| (optional server push)        | `contract-impact`             | `{ project, impact: ImpactReport }` — used after a background diff  |

All handlers must be gated by the same project-scope permission check the KB
endpoints use. Drop payloads whose `project` does not match the current UI
selection (the hook already filters defensively).

## HTTP endpoints (consumed by the CLI)

| Method | Path                       | Body / Query                                        | Response                                 |
| ------ | -------------------------- | --------------------------------------------------- | ---------------------------------------- |
| GET    | `/api/contracts/list`      | `?project=<slug>`                                   | `{ contracts: ContractSummary[] }`       |
| POST   | `/api/contracts/drift`     | `{ project, fromRef, toRef }`                       | `{ impact: ImpactReport }`               |
| POST   | `/api/contracts/generate`  | `{ project, endpointId }`                           | `{ result: GenerateResult }`             |
| POST   | `/api/contracts/verify`    | `{ project }`                                       | `{ result: VerifyRunResult }`            |

CLI shapes for `GenerateResult` / `VerifyRunResult` are in
`cli/src/commands/contracts.ts` — keep server responses field-compatible.

The CLI falls back to reading
`~/.anvil/projects/<slug>/contracts.json` (written by the discovery pass) when
the dashboard is unreachable and `ANVIL_DASHBOARD_URL` is unset.

## Dashboard routing

Add to the sidebar (in the Phase 5 wiring PR, not touched here):

```tsx
// router.tsx
{ path: '/contracts', element: <ContractsMapPage project={project} ws={ws} /> }
```

Sidebar icon: `Server` from `lucide-react`, label "Contracts".

## CLI registration

```ts
// cli/src/index.ts
import { contractsCommand } from './commands/contracts.js';
program.addCommand(contractsCommand);
```
