# Regression Guard Phase 1 — Integration Notes

This module adds PR annotations when a pull request touches a bound-regression
test file. The data source is `BoundTestsStore` (`bound-tests.ts`); no changes
to that store are required.

## WebSocket handlers to add (dashboard-server.ts)

Register two new WS handlers inside the existing `routeMessage` switch:

- `annotate-pr` — input `{ project, prUrl }`. Calls `getPRDiffHunks`,
  `buildBoundAnnotations`, then `postAnnotations`. Emits `pr-annotated`
  `{ prUrl, annotations, status }`.
- `list-bound-annotations` — input `{ project, prUrl }`. Runs the same pipeline
  in dry-run mode (skip `postAnnotations`) and returns annotations for UI
  preview. Emits `bound-annotations` `{ prUrl, annotations }`.

Both handlers should reuse the per-project `BoundTestsStore` instance the
server already constructs for incident endpoints.

## HTTP endpoint (dashboard-server.ts)

Add a dispatcher entry for:

- `POST /api/bound-tests/webhook/github`
  - Read raw body.
  - Read `X-Hub-Signature-256`.
  - `readGithubWebhookSecret(anvilHome)` — auto-creates
    `~/.anvil/secrets/github-webhook-secret` (mode 0600) on first call.
  - `verifyGithubSignature(rawBody.toString('utf-8'), sig, secret)`.
  - Parse JSON, resolve project from `?project=` or `X-Anvil-Project`.
  - `handleGithubPullRequestPayload(payload, { boundStore, project,
    getPRDiffHunks, postAnnotations })`.
  - Respond `202 { status, annotations }`.

## Re-annotate on every push (pipeline-runner.ts)

Subscribe to the existing `pipeline-complete` event. When the event carries a
`prUrl`, call `handleGithubPullRequestPayload` with a synthetic
`{ action: 'synchronize', pull_request: { html_url } }` payload so the comment
is edited in place via the `<!-- anvil-regression-guard -->` marker rather
than duplicated.

## External dependencies

- Requires `gh` CLI on PATH and `gh auth login` completed. Failures degrade
  gracefully — `getPRDiffHunks` returns `[]` and `postAnnotations` logs to
  stderr.
- Respect GitHub's 5k/hour authenticated REST limit by batching via
  `gh api --paginate` (already used internally).
