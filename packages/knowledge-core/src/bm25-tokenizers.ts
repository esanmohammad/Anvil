/**
 * Per-language BM25 tokenizers (P6).
 *
 * Generic whitespace+punctuation tokenization throws away the information
 * that makes BM25 useful for code: Rust's `'static`, Lisp `:keyword`,
 * Erlang atoms, Go's snake_case + camelCase mixing, TS template tags, etc.
 *
 * Each entry exports a `tokenize(text: string) => string[]` that:
 *   - lowercases by default (configurable per-language if case matters),
 *   - splits identifiers across case + underscore + dot boundaries,
 *   - keeps language-significant prefixes/suffixes as their own tokens.
 *
 * The retriever picks a tokenizer via `tokenizerFor(language)`; unknown
 * languages fall through to `genericTokenize` (current behavior).
 */

export type Tokenizer = (text: string) => string[];

/** Split CamelCase / snake_case / kebab-case / dot.path into atoms. */
function splitIdentifier(s: string): string[] {
  const out: string[] = [];
  for (const part of s.split(/[^A-Za-z0-9_$]+/).filter(Boolean)) {
    // Split CamelCase + snake_case.
    const sub = part
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[_\s]+/)
      .filter(Boolean)
      .map((t) => t.toLowerCase());
    out.push(...sub);
    // Also keep the original (lowercased) so exact-match queries still hit.
    out.push(part.toLowerCase());
  }
  return out;
}

export function genericTokenize(text: string): string[] {
  return splitIdentifier(text);
}

export const tokenizers: Record<string, Tokenizer> = {
  typescript: (text) => {
    // Preserve type-annotation markers and JSX-like prefixes.
    const out = splitIdentifier(text);
    const markers = text.match(/\b(interface|type|class|enum|namespace|implements|extends)\b/g);
    if (markers) for (const m of markers) out.push(m.toLowerCase());
    return out;
  },
  javascript: (text) => splitIdentifier(text),
  python: (text) => {
    const out = splitIdentifier(text);
    // Dunder names: __init__, __slots__, etc. — keep as a unit.
    const dunders = text.match(/__[a-zA-Z_][a-zA-Z0-9_]*__/g);
    if (dunders) out.push(...dunders.map((d) => d.toLowerCase()));
    return out;
  },
  go: (text) => {
    const out = splitIdentifier(text);
    // Capture receiver types from method signatures.
    const recvs = text.match(/\([a-zA-Z_]+\s+\*?[A-Z][a-zA-Z0-9]+\)/g);
    if (recvs) {
      for (const r of recvs) {
        const m = r.match(/\*?([A-Z][a-zA-Z0-9]+)/);
        if (m) out.push(m[1].toLowerCase());
      }
    }
    return out;
  },
  rust: (text) => {
    const out = splitIdentifier(text);
    // 'static, 'a lifetimes; keep them as a token.
    const lifetimes = text.match(/'\w+/g);
    if (lifetimes) out.push(...lifetimes.map((l) => l.toLowerCase()));
    // ::path::segments — split into atoms.
    const paths = text.match(/[a-z_][a-z0-9_]*(?:::[a-z_][a-z0-9_]*)+/g);
    if (paths) for (const p of paths) out.push(...p.split('::'));
    return out;
  },
  java: (text) => {
    const out = splitIdentifier(text);
    // Preserve annotation prefixes: @Override etc.
    const annotations = text.match(/@[A-Z][a-zA-Z0-9]*/g);
    if (annotations) out.push(...annotations.map((a) => a.toLowerCase()));
    return out;
  },
  php: (text) => {
    const out = splitIdentifier(text);
    // $variable_name — strip $ and tokenize.
    const vars = text.match(/\$[a-zA-Z_][a-zA-Z0-9_]*/g);
    if (vars) for (const v of vars) out.push(v.slice(1).toLowerCase());
    return out;
  },
};

/** Resolve a tokenizer; fall through to generic when unknown. */
export function tokenizerFor(language: string | undefined): Tokenizer {
  if (!language) return genericTokenize;
  return tokenizers[language.toLowerCase()] ?? genericTokenize;
}
