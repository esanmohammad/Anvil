/**
 * CI Triage Phase 3 — Pattern library for CI log failure classification.
 *
 * Each `PatternRule` matches one known failure bucket (OOM, port conflict,
 * db lock, etc.) with a compiled regex and a canned "suggested fix". The
 * library is consumed by `ci-log-clusterer.ts` to bucket error lines; teams
 * can extend it at runtime via `~/.anvil/projects/<slug>/ci-patterns.json`
 * (see the integration doc).
 *
 * Patterns are ordered from most-specific to most-generic so that the
 * first-match-wins loop in the clusterer classifies lines correctly.
 */

export type CiFailurePattern =
  | 'oom'
  | 'port-conflict'
  | 'db-lock'
  | 'network-timeout'
  | 'known-flake'
  | 'dependency-mismatch'
  | 'permission-denied'
  | 'missing-file'
  | 'compile-error'
  | 'assertion-failure'
  | 'unknown';

export type CiFailureSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface PatternRule {
  pattern: CiFailurePattern;
  severity: CiFailureSeverity;
  matcher: RegExp;
  description: string;
  suggestedFix: string;
}

// ── Pattern library ─────────────────────────────────────────────────────

export const DEFAULT_PATTERN_LIBRARY: PatternRule[] = [
  // ── OOM (critical) ─────────────────────────────────────────────────────
  {
    pattern: 'oom',
    severity: 'critical',
    matcher: /JavaScript heap out of memory|ENOMEM|Killed.*signal 9|cannot allocate memory|OutOfMemoryError|FATAL ERROR: .*Allocation failed/i,
    description: 'Process ran out of memory and was killed.',
    suggestedFix: 'Increase Node heap with --max-old-space-size=4096 or bump the runner to a larger instance. If this happens mid-test, look for a leak in the test setup.',
  },
  {
    pattern: 'oom',
    severity: 'critical',
    matcher: /heap limit Allocation failed|MemoryError|std::bad_alloc|The process ran out of memory/i,
    description: 'Memory exhaustion in a subprocess or native module.',
    suggestedFix: 'Profile with --heap-prof; suspect caches, large JSON parses, or unbounded arrays in hot loops.',
  },

  // ── Port conflict (high) ───────────────────────────────────────────────
  {
    pattern: 'port-conflict',
    severity: 'high',
    matcher: /EADDRINUSE|port.*already in use|address already in use/i,
    description: 'Another process is holding the port.',
    suggestedFix: 'Pick a random free port in test setup (e.g. `await getPort()`), or add a pre-run `lsof -ti:$PORT | xargs kill -9` cleanup step.',
  },
  {
    pattern: 'port-conflict',
    severity: 'high',
    matcher: /bind: address in use|listen tcp.*: bind:|port is already allocated/i,
    description: 'TCP bind failed because the port is owned by another process/container.',
    suggestedFix: 'On CI, ensure the previous job tore down its container; consider dynamic port allocation.',
  },

  // ── DB lock (high) ─────────────────────────────────────────────────────
  {
    pattern: 'db-lock',
    severity: 'high',
    matcher: /deadlock detected|database is locked|Lock wait timeout exceeded|could not obtain lock|SQLITE_BUSY/i,
    description: 'Database lock or deadlock during the run.',
    suggestedFix: 'Reduce test parallelism, isolate tests per-transaction, or ensure tests open a fresh DB/schema per worker.',
  },
  {
    pattern: 'db-lock',
    severity: 'medium',
    matcher: /could not serialize access|40001|serialization failure/i,
    description: 'Serialization failure under concurrent transactions.',
    suggestedFix: 'Add retry-on-40001 or lower isolation where safe. Likely transient.',
  },

  // ── Network timeout (medium) ───────────────────────────────────────────
  {
    pattern: 'network-timeout',
    severity: 'medium',
    matcher: /ETIMEDOUT|ECONNREFUSED|ECONNRESET|request timeout|fetch failed|socket hang up/i,
    description: 'Network call timed out or was refused.',
    suggestedFix: 'Mock the external service in tests; if real, add retries with jitter and check the service health on CI.',
  },
  {
    pattern: 'network-timeout',
    severity: 'medium',
    matcher: /getaddrinfo ENOTFOUND|dial tcp.*timeout|connection reset by peer|EHOSTUNREACH/i,
    description: 'DNS or TCP connect failure.',
    suggestedFix: 'Check CI network egress rules or fall back to a fixture-backed fake.',
  },

  // ── Known flake (low) ──────────────────────────────────────────────────
  {
    pattern: 'known-flake',
    severity: 'low',
    matcher: /flaky test|retrying after failure|test retry \(attempt|Retrying failed tests/i,
    description: 'Runner re-ran a failing test; this one is on the flake list.',
    suggestedFix: 'Quarantine the test in the flake registry and open a ticket. Do not block the PR.',
  },
  {
    pattern: 'known-flake',
    severity: 'low',
    matcher: /intermittent failure|non-deterministic|race condition detected in test/i,
    description: 'Classic non-deterministic signal.',
    suggestedFix: 'Audit for async without await, real timers in tests, or order-dependent setup.',
  },

  // ── Dependency mismatch (high) ─────────────────────────────────────────
  {
    pattern: 'dependency-mismatch',
    severity: 'high',
    matcher: /peer dep|ERESOLVE|Could not resolve dependency|version conflict|incompatible peer dependency/i,
    description: 'Package manager cannot satisfy constraints.',
    suggestedFix: 'Run `npm ls` / `pnpm why` locally, align ranges in package.json, and regenerate the lockfile.',
  },
  {
    pattern: 'dependency-mismatch',
    severity: 'high',
    matcher: /Module version mismatch|NODE_MODULE_VERSION|was compiled against a different Node/i,
    description: 'Native module was built for a different Node ABI.',
    suggestedFix: 'Rebuild native deps on the CI Node version (`npm rebuild`) or pin the Node version in CI to match lockfile.',
  },
  {
    pattern: 'dependency-mismatch',
    severity: 'medium',
    matcher: /Cannot find module|MODULE_NOT_FOUND|import.*could not be resolved/i,
    description: 'A required module is missing from node_modules.',
    suggestedFix: 'Ensure `npm ci` ran before the failing step; check that the dep is in `dependencies` (not `devDependencies`) if needed at runtime.',
  },

  // ── Permission denied (medium) ─────────────────────────────────────────
  {
    pattern: 'permission-denied',
    severity: 'medium',
    matcher: /EACCES|permission denied|operation not permitted|403 Forbidden/i,
    description: 'Filesystem or API permission denied.',
    suggestedFix: 'Check file permissions in the cache layer or grant the CI token the needed scope.',
  },

  // ── Missing file (medium) ──────────────────────────────────────────────
  {
    pattern: 'missing-file',
    severity: 'medium',
    matcher: /ENOENT|no such file or directory|cannot find file|404 not found/i,
    description: 'Expected file / artifact is missing.',
    suggestedFix: 'Verify the previous build step uploaded the artifact; check path casing on Linux runners.',
  },

  // ── Compile error (critical) ───────────────────────────────────────────
  {
    pattern: 'compile-error',
    severity: 'critical',
    matcher: /TS\d{4}:|Syntax error|Parse error|Unexpected token|Compilation failed/i,
    description: 'The code did not compile.',
    suggestedFix: 'Reproduce locally with the same toolchain; the build is not green.',
  },
  {
    pattern: 'compile-error',
    severity: 'critical',
    matcher: /error: cannot find (name|module|type)|error TS\d{4}|tsc: command not found/i,
    description: 'TypeScript / type-checker failure.',
    suggestedFix: 'Run `tsc --noEmit` locally; likely a missing type import or a lockfile drift.',
  },

  // ── Assertion failure (high) ───────────────────────────────────────────
  {
    pattern: 'assertion-failure',
    severity: 'high',
    matcher: /AssertionError|assert.*failed|expected .* to (equal|be|contain)|expect\(.*\)\.to/i,
    description: 'A test assertion failed.',
    suggestedFix: 'Open the test report, inspect the diff of expected vs actual, and reproduce locally.',
  },
  {
    pattern: 'assertion-failure',
    severity: 'high',
    matcher: /Test failed:|FAIL .*\.(test|spec)\.(t|j)sx?|✗ /i,
    description: 'Test runner reported a failing test.',
    suggestedFix: 'Re-run the single failing test with `--reporter=verbose` to capture the stack.',
  },
];
