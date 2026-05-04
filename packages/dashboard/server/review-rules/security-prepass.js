/**
 * Security prepass — regex-based scan of added diff lines.
 *
 * Runs BEFORE the LLM reviewer so we catch cheap, high-signal issues
 * (hardcoded secrets, unsafe sinks, weak crypto, etc.) without burning
 * model tokens. Every finding carries persona:'security' and
 * category:'security'. Confidence reflects how much of a false-positive
 * risk the pattern has on its own.
 *
 * OWASP mapping is noted per-check. No I/O, no dependencies beyond the
 * standard library.
 */
import { matchInAddedLines, snippet, envVarFix, } from './helpers.js';
// ── Named regexes ───────────────────────────────────────────────────────
// Grouped by check family so the patterns are auditable at a glance.
// 1) Hardcoded secrets (OWASP A02:2021 — Cryptographic Failures / A07 — IdAuth)
const AWS_ACCESS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/;
// The AWS secret-key pattern only fires when preceded by a hint keyword.
// Context-dependent: med confidence.
const AWS_SECRET_KEY_RE = /aws[_-]?secret[_-]?access[_-]?key\s*[:=]\s*['"]([A-Za-z0-9/+=]{40})['"]/i;
const PRIVATE_KEY_BLOCK_RE = /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |)PRIVATE KEY-----/;
const BEARER_TOKEN_RE = /['"]Bearer\s+[A-Za-z0-9\-_.]{20,}['"]/;
const SLACK_TOKEN_RE = /\bxox[baprs]-[0-9a-zA-Z-]{10,}\b/;
const GITHUB_TOKEN_RE = /\bgh[pousr]_[A-Za-z0-9]{36,}\b/;
const STRIPE_KEY_RE = /\bsk_(?:live|test)_[A-Za-z0-9]{24,}\b/;
// Generic key=value secrets: context-dependent, lower confidence.
const GENERIC_SECRET_RE = /\b(password|passwd|api[_-]?key|secret|token)\s*[:=]\s*['"]([^'"\s]{7,})['"]/i;
// 2) Unsafe sinks (OWASP A03:2021 — Injection)
const EVAL_CALL_RE = /\beval\s*\(/;
const NEW_FUNCTION_RE = /\bnew\s+Function\s*\(/;
// Command injection: exec/execSync/spawn with a template-literal or string
// concat as the first argument.
const CMD_INJECTION_RE = /\b(?:exec|execSync|spawn|spawnSync)\s*\(\s*(?:`[^`]*\$\{[^`]*`|['"][^'"]*['"]\s*\+|[A-Za-z_$][\w$]*\s*\+)/;
// SQL string concat — SELECT / INSERT / UPDATE / DELETE followed by `${` or ` + `.
const SQL_INJECTION_RE = /\b(?:SELECT|INSERT\s+INTO|UPDATE|DELETE\s+FROM)\b[^'"`\n]{0,80}(?:\$\{|['"]?\s*\+\s*[A-Za-z_$])/i;
const DANGEROUS_INNER_HTML_RE = /\bdangerouslySetInnerHTML\b/;
const DOCUMENT_WRITE_RE = /\bdocument\.write\s*\(/;
// 3) Weak crypto (OWASP A02:2021 — Cryptographic Failures)
const WEAK_HASH_RE = /\bcreateHash\s*\(\s*['"](md5|sha1)['"]\s*\)/i;
const MATH_RANDOM_RE = /Math\.random\s*\(\s*\)/;
const MATH_RANDOM_CONTEXT_RE = /\b(token|key|secret|password|nonce|salt)\b/i;
const PSEUDO_RANDOM_RE = /\bcrypto\.pseudoRandomBytes\s*\(/;
// 4) Open redirect (OWASP A01:2021 — Broken Access Control)
const OPEN_REDIRECT_RE = /\bres\.redirect\s*\(\s*req\.(?:query|params|body|headers)\b/;
// 5) CORS misconfig (OWASP A05:2021 — Security Misconfiguration)
const CORS_WILDCARD_RE = /Access-Control-Allow-Origin\s*['"]?\s*[:,]\s*['"]\*['"]|['"]Access-Control-Allow-Origin['"]\s*,\s*['"]\*['"]/;
function build(args) {
    const f = {
        severity: args.severity,
        category: 'security',
        persona: 'security',
        file: args.file,
        line: args.line,
        snippet: snippet(args.text),
        description: args.description,
        confidence: args.confidence,
        resolution: 'pending',
    };
    if (args.suggestedFix)
        f.suggestedFix = args.suggestedFix;
    return f;
}
// ── Main entry point ────────────────────────────────────────────────────
export function runSecurityPrepass(diff) {
    const findings = [];
    // ── 1. Hardcoded secrets ──────────────────────────────────────────────
    // OWASP A02 — Cryptographic Failures / A07 — IdAuth
    for (const hit of matchInAddedLines(diff, AWS_ACCESS_KEY_RE)) {
        findings.push(build({
            file: hit.file,
            line: hit.lineNumber,
            text: hit.text,
            severity: 'blocker',
            confidence: 'high',
            description: 'Hardcoded AWS access key ID. Rotate the key immediately, revoke it in IAM, and use IAM roles or a secret manager instead of embedding credentials.',
            suggestedFix: envVarFix(hit.match[0], 'AWS_ACCESS_KEY_ID'),
        }));
    }
    for (const hit of matchInAddedLines(diff, AWS_SECRET_KEY_RE)) {
        findings.push(build({
            file: hit.file,
            line: hit.lineNumber,
            text: hit.text,
            severity: 'blocker',
            confidence: 'med', // context-dependent
            description: 'Probable AWS secret access key in source. Rotate the credential and load it from a secret manager / env var.',
            suggestedFix: envVarFix(hit.match[1] ?? hit.match[0], 'AWS_SECRET_ACCESS_KEY'),
        }));
    }
    for (const hit of matchInAddedLines(diff, PRIVATE_KEY_BLOCK_RE)) {
        findings.push(build({
            file: hit.file,
            line: hit.lineNumber,
            text: hit.text,
            severity: 'blocker',
            confidence: 'high',
            description: 'Private key material committed to source. Remove immediately, rotate the key, and store it in a secret manager.',
        }));
    }
    for (const hit of matchInAddedLines(diff, BEARER_TOKEN_RE)) {
        findings.push(build({
            file: hit.file,
            line: hit.lineNumber,
            text: hit.text,
            severity: 'blocker',
            confidence: 'high',
            description: 'Hardcoded Bearer token in a string literal. Rotate the token and read it from an environment variable at runtime.',
            suggestedFix: envVarFix(hit.match[0], 'AUTH_BEARER_TOKEN'),
        }));
    }
    for (const hit of matchInAddedLines(diff, SLACK_TOKEN_RE)) {
        findings.push(build({
            file: hit.file,
            line: hit.lineNumber,
            text: hit.text,
            severity: 'blocker',
            confidence: 'high',
            description: 'Hardcoded Slack token. Revoke via Slack app admin and move to a secret manager.',
            suggestedFix: envVarFix(hit.match[0], 'SLACK_TOKEN'),
        }));
    }
    for (const hit of matchInAddedLines(diff, GITHUB_TOKEN_RE)) {
        findings.push(build({
            file: hit.file,
            line: hit.lineNumber,
            text: hit.text,
            severity: 'blocker',
            confidence: 'high',
            description: 'Hardcoded GitHub token. Revoke the PAT / app token immediately and read it from env or a secret manager.',
            suggestedFix: envVarFix(hit.match[0], 'GITHUB_TOKEN'),
        }));
    }
    for (const hit of matchInAddedLines(diff, STRIPE_KEY_RE)) {
        findings.push(build({
            file: hit.file,
            line: hit.lineNumber,
            text: hit.text,
            severity: 'blocker',
            confidence: 'high',
            description: 'Hardcoded Stripe API key. Roll the key in the Stripe dashboard and load it from an environment variable.',
            suggestedFix: envVarFix(hit.match[0], 'STRIPE_SECRET_KEY'),
        }));
    }
    for (const hit of matchInAddedLines(diff, GENERIC_SECRET_RE)) {
        const keyword = (hit.match[1] ?? 'secret').toUpperCase().replace(/[^A-Z0-9]/g, '_');
        findings.push(build({
            file: hit.file,
            line: hit.lineNumber,
            text: hit.text,
            severity: 'error',
            confidence: 'med', // many false positives (example/test values)
            description: `Possible hardcoded ${hit.match[1]} assignment. If this is a real credential, rotate it and load from an env var. If it is a test fixture, mark it as such and avoid realistic-looking values.`,
            suggestedFix: envVarFix(hit.match[0], keyword),
        }));
    }
    // ── 2. Unsafe sinks (OWASP A03 — Injection) ───────────────────────────
    for (const hit of matchInAddedLines(diff, EVAL_CALL_RE)) {
        findings.push(build({
            file: hit.file,
            line: hit.lineNumber,
            text: hit.text,
            severity: 'error',
            confidence: 'med',
            description: '`eval()` executes arbitrary code and is a common RCE vector. Parse structured data (JSON) or use a safe evaluator instead.',
        }));
    }
    for (const hit of matchInAddedLines(diff, NEW_FUNCTION_RE)) {
        findings.push(build({
            file: hit.file,
            line: hit.lineNumber,
            text: hit.text,
            severity: 'error',
            confidence: 'med',
            description: '`new Function(...)` compiles a string as code — equivalent to `eval`. Avoid unless you fully control the input.',
        }));
    }
    for (const hit of matchInAddedLines(diff, CMD_INJECTION_RE)) {
        findings.push(build({
            file: hit.file,
            line: hit.lineNumber,
            text: hit.text,
            severity: 'error',
            confidence: 'high',
            description: 'Command execution with interpolated / concatenated input is a classic shell injection vector. Pass arguments as an array to spawn() and never build a command string from user input.',
        }));
    }
    for (const hit of matchInAddedLines(diff, SQL_INJECTION_RE)) {
        findings.push(build({
            file: hit.file,
            line: hit.lineNumber,
            text: hit.text,
            severity: 'error',
            confidence: 'high',
            description: 'SQL query built via string concatenation or template interpolation. Use parameterised queries / prepared statements to prevent SQL injection.',
        }));
    }
    for (const hit of matchInAddedLines(diff, DANGEROUS_INNER_HTML_RE)) {
        findings.push(build({
            file: hit.file,
            line: hit.lineNumber,
            text: hit.text,
            severity: 'error',
            confidence: 'med',
            description: '`dangerouslySetInnerHTML` bypasses React\'s XSS protections (OWASP A03). Sanitize with DOMPurify or render trusted content through regular JSX.',
        }));
    }
    for (const hit of matchInAddedLines(diff, DOCUMENT_WRITE_RE)) {
        findings.push(build({
            file: hit.file,
            line: hit.lineNumber,
            text: hit.text,
            severity: 'error',
            confidence: 'med',
            description: '`document.write` can introduce XSS and breaks CSP. Use DOM APIs or framework rendering instead.',
        }));
    }
    // ── 3. Weak crypto (OWASP A02) ────────────────────────────────────────
    for (const hit of matchInAddedLines(diff, WEAK_HASH_RE)) {
        const algo = (hit.match[1] || '').toLowerCase();
        findings.push(build({
            file: hit.file,
            line: hit.lineNumber,
            text: hit.text,
            severity: 'warn',
            confidence: 'med',
            description: `Weak hash algorithm "${algo}" — broken for collision resistance. Use sha256 or better; for password hashing use bcrypt/argon2/scrypt.`,
        }));
    }
    for (const hit of matchInAddedLines(diff, MATH_RANDOM_RE)) {
        if (!MATH_RANDOM_CONTEXT_RE.test(hit.text))
            continue;
        findings.push(build({
            file: hit.file,
            line: hit.lineNumber,
            text: hit.text,
            severity: 'warn',
            confidence: 'low', // context-dependent, noisy
            description: '`Math.random()` is not cryptographically secure. Use `crypto.randomBytes` or `crypto.randomUUID` when generating tokens, keys, nonces, or salts.',
        }));
    }
    for (const hit of matchInAddedLines(diff, PSEUDO_RANDOM_RE)) {
        findings.push(build({
            file: hit.file,
            line: hit.lineNumber,
            text: hit.text,
            severity: 'warn',
            confidence: 'med',
            description: '`crypto.pseudoRandomBytes` is not cryptographically strong — use `crypto.randomBytes` instead.',
        }));
    }
    // ── 4. Open redirect (OWASP A01) ──────────────────────────────────────
    for (const hit of matchInAddedLines(diff, OPEN_REDIRECT_RE)) {
        findings.push(build({
            file: hit.file,
            line: hit.lineNumber,
            text: hit.text,
            severity: 'warn',
            confidence: 'high',
            description: 'Redirect target is user-controlled — classic open-redirect pattern (phishing vector). Validate the target against an allow-list of known safe URLs / paths before redirecting.',
        }));
    }
    // ── 5. CORS misconfig (OWASP A05) ─────────────────────────────────────
    for (const hit of matchInAddedLines(diff, CORS_WILDCARD_RE)) {
        findings.push(build({
            file: hit.file,
            line: hit.lineNumber,
            text: hit.text,
            severity: 'warn',
            confidence: 'med',
            description: 'Wildcard `Access-Control-Allow-Origin: *` disables origin restriction. Prefer an explicit allow-list; `*` is incompatible with credentialed requests anyway.',
        }));
    }
    return findings;
}
//# sourceMappingURL=security-prepass.js.map