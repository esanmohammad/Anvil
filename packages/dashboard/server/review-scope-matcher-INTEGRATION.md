# Review Scope Matcher — Integration Notes (Phase R1)

Phase R1 introduces persona topic-scope gating so we skip irrelevant personas
per file (no SQL findings on `.tsx`, no XSS on pure Go). The primitives
(`review-persona-scopes.ts`, `review-scope-matcher.ts`) are standalone — no
shared file has been modified. This file lists what the integration step needs
to wire in.

## 1. Call `routeFilesToPersonas` before persona dispatch

In `review-publisher.ts` (or whichever module orchestrates persona fan-out),
right after the PR diff is expanded into `{ path, contents }` pairs and before
each persona is invoked, add:

```ts
import { routeFilesToPersonas } from './review-scope-matcher.js';
import { listPersonaIds } from './review-persona-scopes.js';

const activePersonas = cfg.personas ?? listPersonaIds();
const routed = routeFilesToPersonas(prFiles, activePersonas);

for (const personaId of activePersonas) {
  const files = routed[personaId];
  if (!files || files.length === 0) continue; // skip — out of topic
  await runPersona(personaId, files, ctx);
}
```

Findings attached to personas that were skipped simply never enter the review.
No change to `review-store.ts` is required: empty persona batches produce no
findings, and `review.personas` in the summary already reflects only invoked
personas.

## 2. Per-project scope overrides

Teams can narrow or broaden scopes via
`~/.anvil/projects/<slug>/review-scopes.yaml`:

```yaml
overrides:
  sql-injection-reviewer:
    pathPatterns:
      - "services/**/*.go"
      - "services/**/*.ts"
  xss-reviewer:
    disable: true
```

Loader contract (future work): read the YAML at review start, deep-merge into a
copy of `PERSONA_SCOPES`, and pass the merged map to `routeFilesToPersonas`
via a future `routeFilesToPersonasWith(scopes, files, ids)` overload. Today,
teams can get the same effect by limiting `activePersonas` or by editing the
scope table and recompiling.

## 3. Where NOT to put this

Do not filter inside each persona prompt. The gate must happen *before*
persona invocation so we don't pay LLM cost for files that cannot contain the
vulnerability class.
