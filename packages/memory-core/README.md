# `@anvil/memory-core`

Long-term memory layer for Anvil — five-type taxonomy
(`working` / `episodic` / `semantic` / `procedural` / `profile`),
bi-temporal facts, code-fact drift detection, sleeptime ratification,
and PR-as-episode primitives.

> **Status:** Phase 1 (scaffold). Canonical types only. Functional
> implementation lands in Phases 2–14 per
> [`MEMORY-CORE-EXTRACT-PLAN.md`](../../MEMORY-CORE-EXTRACT-PLAN.md);
> decisions are locked in
> [`MEMORY-CORE-ADR.md`](../../MEMORY-CORE-ADR.md).

## Why this exists

Memory composes with the rest of Anvil's agent stack:

- It persists `LanguageModel` invocation traces (Plan A's seam).
- It hooks into the OTel telemetry layer (Plan B's spans become memory candidates).
- Its procedural-memory output proposes new SKILL.md files (Plan C's loader consumes them).
- Its `runAgent` integration carries memory into headless eval runs (Plan C's headless entry).

Building memory before A/B/C would have meant re-plumbing it after each later plan.
After A/B/C, the integration points are stable.

## Public API

### Phase 1 (this release)

Canonical types — these freeze the schema future phases consume:

```ts
import type {
  Memory,
  MemoryKind,
  MemoryNamespace,
  MemoryProvenance,
  CodeFactBinding,
  BiTemporal,
  DecayState,
  Proposal,
  PrEpisode,
} from '@anvil/memory-core';
```

### Phase 2+ (forthcoming)

Functional surface lands in subsequent phases — see
[`MEMORY-CORE-EXTRACT-PLAN.md`](../../MEMORY-CORE-EXTRACT-PLAN.md) for the
phase-by-phase rollout.

## Lock-in surface

- **`better-sqlite3`** (MIT) — sync, single-file, native bindings with
  prebuilds for every Node-supported platform. Replacement cost: rewrite
  the storage adapter (~200 LOC). Acceptable.
- **`ulid`** (MIT) — ID generation; sortable lexicographically by creation
  time, URL-safe, 26 chars.
- **LanceDB via `@anvil/knowledge-core`** — already in tree; no new
  commitment.
- **No graph DB.** Adjacency tables in SQLite + Personalized PageRank
  computed in TS over JS arrays. ~80 LOC.
- **No mem0, Letta, Zep, LangMem, or Cognee SDKs.** Patterns stolen, code
  hand-rolled.
