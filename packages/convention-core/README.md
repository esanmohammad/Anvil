# @anvil/convention-core

**Your codebase has rules. Anvil learns them.**

A self-improving convention engine — observes how your repo really
writes code, distills it into reviewable rules, and promotes
recurring mistakes into hard checks the next agent must follow.

---

## The problem

Style guides go stale. Linters cover syntax, not intent. PR reviewers
keep typing the same comment. Meanwhile the AI agent on the other
side keeps producing code that's *technically valid* but doesn't
look like the rest of your project.

**convention-core closes the loop.** It scans the repo, infers the
patterns your team actually uses, formats them as living
documentation, and feeds them back into every agent prompt. When the
same violation gets caught three times, it gets promoted to a rule.

```ts
import {
  extractConventions,
  aggregateConventions,
  formatConventions,
} from '@anvil/convention-core';

// Walk the repo, detect patterns across naming, imports, tests,
// error handling.
const conventions = await extractConventions(repoRoot);
const aggregated = aggregateConventions([conventions]);

// Render as markdown for inclusion in agent prompts.
const md = formatConventions(aggregated);
// → "Files: kebab-case (87 / 92 — 95%)
//    Imports: relative for siblings, absolute for cross-package…"
```

---

## What you get

### Four built-in detectors
File naming · import patterns · test patterns · error handling.
Each detector returns a structured signal with confidence — "87 of
92 files use kebab-case" beats "we use kebab-case." Agents see the
*evidence*, not just the verdict.

### Aggregation across repos
A single Anvil project can span multiple repos. `aggregateConventions`
unifies signals so a monorepo's web + api + ui packages share the
conventions where they agree and surface tension where they don't.

### Default rule sets, ready to go
TypeScript · Go · Kafka. Battle-tested rules ship as YAML — drop
them into a project unmodified or use them as a starting point.
Augment with your own; the merger handles overrides cleanly.

### Promotion ledger
The mechanism that makes the engine *learn*. Every rule violation
is recorded. After a configurable threshold, the violation is
promoted: the violation tracker generates a normalized rule, the
ledger persists it, and future runs treat it as a hard check.
Lessons compound; the agent doesn't keep making the same mistake.

### Rule engine + severity model
`evaluateRules` runs a `RuleSet` against a candidate change and
emits typed `RuleViolation`s with `info` / `warn` / `error`
severity. Plugs into the dashboard's review prepass so violations
appear inline before any LLM is asked to review.

### Markdown + JSON storage
- `~/.anvil/conventions/<project>/conventions.md` — human-readable,
  agent-readable, git-friendly.
- `~/.anvil/conventions/<project>/rules.json` — machine-checked
  by the rule engine.

Two views, one source of truth.

---

## Where it shows up in Anvil

- **`anvil learn`** populates the convention store from the repo.
- **The dashboard's pipeline runner** injects the markdown into
  every agent prompt that touches code.
- **The review prepass** runs rules.json against candidate diffs
  before a reviewer model is even spawned — fast, deterministic,
  free.
- **The promotion hook** fires on every reviewer verdict, so
  recurring complaints become enforced rules without human
  bookkeeping.

---

## Architecture at a glance

```
   repo files
       │
       ▼
   ┌──────────────────────────────────────────────┐
   │  Detectors                                   │
   │   ├─ file-naming    ├─ import-patterns       │
   │   ├─ test-patterns  └─ error-handling        │
   └──────────────────────┬───────────────────────┘
                          │ per-repo signals
                          ▼
                ┌────────────────────┐
                │  aggregateConventions │  cross-repo unification
                └──────────┬─────────┘
                           ├──▶ formatConventions  → conventions.md
                           └──▶ synthesize-rules   → rules.json
                                                       │
                                                       ▼
                                           ┌────────────────────┐
                                           │  Rule engine       │
                                           │  evaluateRules     │
                                           └──────────┬─────────┘
                                                      │ violations
                                                      ▼
                                           ┌────────────────────┐
                                           │  Promotion ledger  │  threshold-gated
                                           │  (track → promote) │  rule generation
                                           └────────────────────┘
```

---

## Philosophy

**Conventions live in the code, not the wiki.** The detector pipeline
treats the repo as the source of truth. If your code says one thing
and your style guide says another, the code wins.

**Evidence over assertion.** A rule with "87 / 92 files" is more
useful to an agent than a rule with "always use kebab-case." Counts
beat commands.

**Lessons compound.** The promotion ledger is the spine of the
package — it's what turns "we keep complaining about this" into "we
won't complain about this again."

**No language-specific lock-in.** Detectors are pluggable. Default
rule sets are YAML. New languages and frameworks ship as data,
not code rewrites.

---

## Status

Stable: extraction, aggregation, formatter, rule engine, default
rule sets (TS / Go / Kafka), promotion ledger, dashboard
integration. Active follow-up: more detectors, a richer rule DSL.

---

## Part of [Anvil](../../) — the AI development pipeline.
