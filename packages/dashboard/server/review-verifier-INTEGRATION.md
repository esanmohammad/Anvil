# review-verifier (R3) integration

## Where to wire

Inside `review-publisher.ts`, AFTER the R2 evidence gate (`applyEvidenceGate`)
has filtered findings and BEFORE the review is persisted or comments are
posted.

Pseudocode:

```ts
import { verifyFindings } from './review-verifier.js';

// ... after applyEvidenceGate returns `gated`
let final = gated;
if (process.env.ANVIL_REVIEW_VERIFY_ENABLED === '1') {
  const { verified } = await verifyFindings(gated, {
    repoLocalPath: project.localPath,
    fileContents: diff.fileContents,
  }, { timeoutMs: 10_000, memoryLimitMb: 128, concurrency: 3 });
  final = verified;
}
// persist(final); post comments from `final`.
```

## Feature flag

`ANVIL_REVIEW_VERIFY_ENABLED=1`. Verifier is expensive (spawns subprocesses,
runs `tsc`, `python3`, `go`), so it must be opt-in. Default is off.

## Caps

- Per-test timeout: 10 s (configurable via `timeoutMs`).
- Node memory: 128 MB via `--max-old-space-size` (in NODE_OPTIONS).
- Concurrency: max 3 parallel verifications to avoid fork-bombing CI.

## Security

- `cwd` is a fresh OS tmp dir per run; the generated file must live under
  `os.tmpdir()` or the configured `repoLocalPath` — otherwise the sandbox
  refuses to run.
- Env is filtered to `PATH`, `HOME`, `NODE_PATH`, `NODE_OPTIONS`, `LC_ALL`.
- `shell: false` on every spawn; no argv interpolation by the shell.
- Function names are validated against a strict identifier regex before they
  are interpolated into generated source.

## Dropped vs skipped

- `verified.length + dropped.length === findings.length`.
- `skipped` findings (unsupported language, missing runner, no generator)
  are returned unchanged in `verified` — the verifier is informational and
  never drops a finding it could not evaluate.
