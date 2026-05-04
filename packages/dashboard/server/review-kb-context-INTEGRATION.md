# Review Phase R5 — KB Impact Context — Integration Notes

This phase pre-computes per-symbol AST-graph impact (callers, callees,
cross-repo consumers, public-API flag, ripple estimate) and feeds it to review
personas. Two new modules:

- `review-kb-context.ts` — pure `computeKbContext(changedFiles, repoGraphs)`.
- `review-kb-summarizer.ts` — `summarizeForPrompt(report, opts)`.

## Where to wire it in `review-publisher.ts`

Call the pair just before personas are spawned (after the diff has been
collected, before the persona system prompts are assembled):

```ts
import { computeKbContext } from './review-kb-context.js';
import { summarizeForPrompt } from './review-kb-summarizer.js';

const repoGraphs = loadRepoGraphs(project, changedRepos);
const kbReport = computeKbContext(changedFiles, repoGraphs);
const kbSummary = summarizeForPrompt(kbReport, { maxLineBudget: 40 });
```

`changedFiles` is already derived inside `review-publisher.ts` from the PR
diff. When the diff parser can extract added symbol names (functions,
components, exports), pass them as `addedSymbols`; otherwise omit the field
and the module will enumerate every symbol the graph knows about for that
file.

## Loading graphs (fallback-safe)

```ts
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function loadRepoGraphs(project: string, repoNames: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const base = join(process.env.ANVIL_HOME ?? join(homedir(), '.anvil'), 'kb', project);
  for (const name of repoNames) {
    const path = join(base, name, 'graph.json');
    if (!existsSync(path)) continue; // module treats missing repos as orphans
    try { out[name] = JSON.parse(readFileSync(path, 'utf-8')); } catch { /* ignore */ }
  }
  return out;
}
```

Note: `KnowledgeBaseManager` currently writes to `~/.anvil/knowledge-base/…`.
If that path is preferred, substitute `knowledge-base` for `kb`. Either way,
missing graphs degrade gracefully — the report lists them under `orphans` and
personas still receive the diff.

## Prompt injection

Append `kbSummary` to each persona's system prompt after the diff block, under
a header like `## KB impact (R5)`. Keep it below the diff so personas read
diffs first, then reach for impact context when forming their critique.
