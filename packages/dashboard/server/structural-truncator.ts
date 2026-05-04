/**
 * Code-aware truncation — Phase 4 replacement for `smartTruncate`'s middle-cut.
 *
 * `smartTruncate` keeps the first 40% and last 20% of a string, which works
 * fine for prose but mangles code: half a class header here, an orphaned
 * `}` there. This module takes a code blob, identifies imports, top-level
 * declarations, and bodies via the same boundary regexes the chunker uses,
 * then greedy-packs the result inside a token budget while preferring:
 *
 *   imports  >  exported declarations (full body)
 *            >  exported declarations (signature only)
 *            >  non-exported declarations (signature only)
 *
 * Skipped or stripped symbols are summarised with a single trailing marker
 * so the consumer (an LLM stage) can tell something was dropped.
 *
 * Pure string in / string out — no filesystem, no AST library.
 */

type Lang = 'typescript' | 'javascript' | 'python' | 'go' | 'rust' | 'java' | 'unknown';

export interface StructuralTruncateOptions {
  /** Token budget for the returned string (heuristic chars/4). */
  budgetTokens: number;
  /** Optional file extension or language label to guide pattern selection. */
  languageHint?: string;
}

interface BoundaryHit {
  line: number;
  entityType: 'function' | 'class' | 'method' | 'interface' | 'type' | 'enum';
  name: string | undefined;
  isExported: boolean;
}

interface TopLevelSymbol {
  startLine: number;       // 0-based inclusive
  endLine: number;         // 0-based inclusive
  signatureLine: string;   // raw line at startLine
  entityType: BoundaryHit['entityType'];
  name: string | undefined;
  isExported: boolean;
  body: string;            // signatureLine + remaining lines joined with \n
}

const TRUNCATION_MARKER = '// [N more symbols truncated]';
const PYTHON_TRUNCATION_MARKER = '# [N more symbols truncated]';
const SIGNATURE_BODY_PLACEHOLDER = ' { /* body truncated */ }';
const PYTHON_BODY_PLACEHOLDER = '    ...  # body truncated';

// ── Language detection ──────────────────────────────────────────────────

function detectLanguage(hint: string | undefined, text: string): Lang {
  if (hint) {
    const h = hint.toLowerCase();
    if (/\.(ts|tsx|mts|cts)$/.test(h) || h === 'typescript') return 'typescript';
    if (/\.(js|jsx|mjs|cjs)$/.test(h) || h === 'javascript') return 'javascript';
    if (/\.py$/.test(h) || h === 'python') return 'python';
    if (/\.go$/.test(h) || h === 'go') return 'go';
    if (/\.rs$/.test(h) || h === 'rust') return 'rust';
    if (/\.java$/.test(h) || h === 'java') return 'java';
  }
  // Heuristic fallback — sample first 50 lines.
  const sample = text.split('\n', 50).join('\n');
  if (/^(from\s+\w|import\s+\w+\s*$|def\s+\w|class\s+\w)/m.test(sample)) return 'python';
  if (/^package\s+\w|^func\s+\w/m.test(sample)) return 'go';
  if (/^(pub\s+)?(fn|struct|enum|trait|impl)\s+/m.test(sample)) return 'rust';
  if (/^(import|export|interface|type\s+\w+\s*=)/m.test(sample)) return 'typescript';
  return 'unknown';
}

// ── Token estimation (chars/4 — same heuristic as context-budget) ──────

function estTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

// ── Import detection ────────────────────────────────────────────────────

/** Returns the slice of consecutive top-of-file import lines (and blanks/comments between them). */
function extractImportBlock(lines: string[], lang: Lang): { block: string; consumedThrough: number } {
  if (lang === 'unknown') return { block: '', consumedThrough: -1 };

  const importRegex: RegExp = (() => {
    switch (lang) {
      case 'typescript':
      case 'javascript':
        return /^\s*(import\b|export\s+(\*|\{|type\s+\{)|const\s+\{[^}]*\}\s*=\s*require\(|require\()/;
      case 'python':
        return /^\s*(from\s+[\w.]+\s+import|import\s+[\w.]+)/;
      case 'go':
        return /^\s*(package\s+|import\s+(\(|"|`))/;
      case 'rust':
        return /^\s*(use\s+|extern\s+crate\s+|mod\s+\w+;)/;
      case 'java':
        return /^\s*(package\s+|import\s+)/;
      default:
        return /^$/; // never matches
    }
  })();

  // Walk down accepting imports + blank lines + single-line comments,
  // bail on the first content line that isn't one of those.
  let lastImport = -1;
  for (let i = 0; i < Math.min(lines.length, 200); i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (importRegex.test(line)) {
      lastImport = i;
      continue;
    }
    if (trimmed === '') continue;
    if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('/*') || trimmed.startsWith('*')) continue;
    break;
  }
  if (lastImport < 0) return { block: '', consumedThrough: -1 };

  // Special case for Go: handle multi-line `import ( ... )` — extend through closing paren.
  if (lang === 'go') {
    for (let j = lastImport; j < Math.min(lines.length, 400); j++) {
      const t = lines[j];
      if (/^\s*\)\s*$/.test(t)) {
        lastImport = j;
        break;
      }
      if (/^\s*\)/.test(t)) {
        lastImport = j;
        break;
      }
    }
  }

  return {
    block: lines.slice(0, lastImport + 1).join('\n'),
    consumedThrough: lastImport,
  };
}

// ── Boundary detection (mirrors chunker.ts patterns at top level) ──────

function findTopLevelBoundaries(lines: string[], lang: Lang, startFrom: number): BoundaryHit[] {
  const hits: BoundaryHit[] = [];
  const tsRules = [
    { re: /^export\s+(default\s+)?async\s+function\s+(\w+)/, type: 'function' as const, isExported: true, nameIdx: 2 },
    { re: /^export\s+(default\s+)?function\s+(\w+)/, type: 'function' as const, isExported: true, nameIdx: 2 },
    { re: /^export\s+(default\s+)?class\s+(\w+)/, type: 'class' as const, isExported: true, nameIdx: 2 },
    { re: /^export\s+(abstract\s+)?class\s+(\w+)/, type: 'class' as const, isExported: true, nameIdx: 2 },
    { re: /^export\s+const\s+(\w+)/, type: 'function' as const, isExported: true, nameIdx: 1 },
    { re: /^export\s+interface\s+(\w+)/, type: 'interface' as const, isExported: true, nameIdx: 1 },
    { re: /^export\s+type\s+(\w+)/, type: 'type' as const, isExported: true, nameIdx: 1 },
    { re: /^export\s+enum\s+(\w+)/, type: 'enum' as const, isExported: true, nameIdx: 1 },
    { re: /^async\s+function\s+(\w+)/, type: 'function' as const, isExported: false, nameIdx: 1 },
    { re: /^function\s+(\w+)/, type: 'function' as const, isExported: false, nameIdx: 1 },
    { re: /^class\s+(\w+)/, type: 'class' as const, isExported: false, nameIdx: 1 },
    { re: /^interface\s+(\w+)/, type: 'interface' as const, isExported: false, nameIdx: 1 },
    { re: /^type\s+(\w+)/, type: 'type' as const, isExported: false, nameIdx: 1 },
    { re: /^enum\s+(\w+)/, type: 'enum' as const, isExported: false, nameIdx: 1 },
    { re: /^const\s+(\w+)\s*=/, type: 'function' as const, isExported: false, nameIdx: 1 },
  ];
  const pyRules = [
    { re: /^class\s+(\w+)/, type: 'class' as const, getName: 1 },
    { re: /^async\s+def\s+(\w+)/, type: 'function' as const, getName: 1 },
    { re: /^def\s+(\w+)/, type: 'function' as const, getName: 1 },
  ];
  const goRules = [
    { re: /^func\s+(?:\([^)]*\)\s+)?(\w+)/, type: 'function' as const, getName: 1 },
    { re: /^type\s+(\w+)\s+struct/, type: 'class' as const, getName: 1 },
    { re: /^type\s+(\w+)\s+interface/, type: 'interface' as const, getName: 1 },
  ];
  const rustRules = [
    { re: /^(pub\s+)?(?:async\s+)?fn\s+(\w+)/, type: 'function' as const, isExportedIdx: 1, nameIdx: 2 },
    { re: /^(pub\s+)?struct\s+(\w+)/, type: 'class' as const, isExportedIdx: 1, nameIdx: 2 },
    { re: /^(pub\s+)?enum\s+(\w+)/, type: 'enum' as const, isExportedIdx: 1, nameIdx: 2 },
    { re: /^(pub\s+)?trait\s+(\w+)/, type: 'interface' as const, isExportedIdx: 1, nameIdx: 2 },
    { re: /^impl\s+(?:<[^>]+>\s+)?(\w+)/, type: 'class' as const, isExportedIdx: -1, nameIdx: 1 },
  ];
  const javaRules = [
    { re: /^public\s+(?:abstract\s+|final\s+)?class\s+(\w+)/, type: 'class' as const, isExported: true, nameIdx: 1 },
    { re: /^public\s+interface\s+(\w+)/, type: 'interface' as const, isExported: true, nameIdx: 1 },
    { re: /^class\s+(\w+)/, type: 'class' as const, isExported: false, nameIdx: 1 },
  ];

  for (let i = startFrom; i < lines.length; i++) {
    const raw = lines[i];
    if (raw.length === 0) continue;
    // Top-level only — skip indented lines (column-0 only).
    if (raw[0] === ' ' || raw[0] === '\t') continue;
    const trimmed = raw;
    // Python is whitespace-significant; for Python, top-level = indent 0.
    // For braces languages, top-level = column 0.
    if (lang === 'typescript' || lang === 'javascript') {
      for (const r of tsRules) {
        const m = trimmed.match(r.re);
        if (m) {
          hits.push({
            line: i,
            entityType: r.type,
            name: m[r.nameIdx],
            isExported: r.isExported,
          });
          break;
        }
      }
    } else if (lang === 'python') {
      for (const r of pyRules) {
        const m = trimmed.match(r.re);
        if (m) {
          hits.push({
            line: i,
            entityType: r.type,
            name: m[r.getName],
            isExported: !m[r.getName]?.startsWith('_'),
          });
          break;
        }
      }
    } else if (lang === 'go') {
      for (const r of goRules) {
        const m = trimmed.match(r.re);
        if (m) {
          const name = m[r.getName];
          hits.push({
            line: i,
            entityType: r.type,
            name,
            isExported: !!name && /^[A-Z]/.test(name),
          });
          break;
        }
      }
    } else if (lang === 'rust') {
      for (const r of rustRules) {
        const m = trimmed.match(r.re);
        if (m) {
          const isExported = r.isExportedIdx >= 0 ? !!m[r.isExportedIdx] : false;
          hits.push({
            line: i,
            entityType: r.type,
            name: m[r.nameIdx],
            isExported,
          });
          break;
        }
      }
    } else if (lang === 'java') {
      for (const r of javaRules) {
        const m = trimmed.match(r.re);
        if (m) {
          hits.push({
            line: i,
            entityType: r.type,
            name: m[r.nameIdx],
            isExported: r.isExported,
          });
          break;
        }
      }
    }
  }
  return hits;
}

// ── Symbol assembly (boundary lines → full bodies) ──────────────────────

function assembleSymbols(lines: string[], boundaries: BoundaryHit[]): TopLevelSymbol[] {
  const out: TopLevelSymbol[] = [];
  for (let i = 0; i < boundaries.length; i++) {
    const start = boundaries[i].line;
    const end = i + 1 < boundaries.length ? boundaries[i + 1].line - 1 : lines.length - 1;
    const bodyLines = lines.slice(start, end + 1);
    out.push({
      startLine: start,
      endLine: end,
      signatureLine: lines[start],
      entityType: boundaries[i].entityType,
      name: boundaries[i].name,
      isExported: boundaries[i].isExported,
      body: bodyLines.join('\n'),
    });
  }
  return out;
}

// ── Signature stub (when we keep the symbol but drop the body) ─────────

function signatureStub(sym: TopLevelSymbol, lang: Lang): string {
  // Strip trailing `{` etc. and append a placeholder so the resulting blob
  // remains roughly parseable to a reader (not necessarily a compiler).
  const sig = sym.signatureLine.replace(/\s*\{\s*$/, '').trimEnd();
  if (lang === 'python') {
    return sig + '\n' + PYTHON_BODY_PLACEHOLDER;
  }
  // Pure types and interfaces — don't append `{ /* body */ }`, they often have
  // no body shape on the signature line (e.g. `export type X = ...`).
  if (sym.entityType === 'type') return sig;
  // Default: append `{ /* body truncated */ }` so braces stay matched-ish.
  if (/[;{]\s*$/.test(sym.signatureLine)) return sig + SIGNATURE_BODY_PLACEHOLDER;
  return sig + SIGNATURE_BODY_PLACEHOLDER;
}

// ── Greedy packing ──────────────────────────────────────────────────────

function packSymbols(
  imports: string,
  symbols: TopLevelSymbol[],
  budgetTokens: number,
  lang: Lang,
): string {
  const pieces: string[] = [];
  let remaining = budgetTokens;

  // Reserve some headroom for the trailing marker so we never overshoot.
  const markerCost = estTokens(TRUNCATION_MARKER) + 2;

  if (imports) {
    const cost = estTokens(imports);
    if (cost <= remaining) {
      pieces.push(imports);
      remaining -= cost;
    } else {
      // imports alone bust the budget — keep the first `remaining * 4` chars.
      pieces.push(imports.slice(0, Math.max(0, remaining * 4)));
      remaining = 0;
    }
  }

  // Two-pass: full bodies for exports first, then non-exports, then signature stubs for the rest.
  // We track which symbols got "full body" already so we don't double-count.
  const exportedFull = new Set<number>();
  const exportedSig = new Set<number>();

  // Pass 1: full bodies for exports.
  for (let i = 0; i < symbols.length; i++) {
    const s = symbols[i];
    if (!s.isExported) continue;
    const cost = estTokens(s.body) + 1;
    if (cost + markerCost <= remaining) {
      pieces.push(s.body);
      remaining -= cost;
      exportedFull.add(i);
    } else {
      // Try the stub.
      const stub = signatureStub(s, lang);
      const stubCost = estTokens(stub) + 1;
      if (stubCost + markerCost <= remaining) {
        pieces.push(stub);
        remaining -= stubCost;
        exportedSig.add(i);
      }
    }
  }

  // Pass 2: full bodies for non-exports, only if we still have meaningful budget.
  for (let i = 0; i < symbols.length; i++) {
    const s = symbols[i];
    if (s.isExported) continue;
    const cost = estTokens(s.body) + 1;
    if (cost + markerCost <= remaining) {
      pieces.push(s.body);
      remaining -= cost;
    } else {
      // Stubs for non-exports — only add if cheap and budget allows.
      const stub = signatureStub(s, lang);
      const stubCost = estTokens(stub) + 1;
      if (stubCost + markerCost <= remaining) {
        pieces.push(stub);
        remaining -= stubCost;
      }
    }
  }

  // Count what got dropped vs. stubbed for the trailing marker.
  const total = symbols.length;
  const kept = exportedFull.size;
  const stubsOrDropped = total - kept;
  if (stubsOrDropped > 0) {
    const markerText = (lang === 'python' ? PYTHON_TRUNCATION_MARKER : TRUNCATION_MARKER)
      .replace('N', String(stubsOrDropped));
    pieces.push(markerText);
  }

  return pieces.join('\n\n');
}

// ── Public API ──────────────────────────────────────────────────────────

/**
 * Truncate a code blob to fit within `budgetTokens` while preserving as much
 * structural signal as possible (imports, exported declarations, signatures).
 *
 * Returns the input unchanged when it already fits the budget, OR when the
 * language couldn't be detected with confidence — caller should fall back to
 * prose-style middle-cut in that case.
 */
export function structurallyTruncate(text: string, opts: StructuralTruncateOptions): string {
  if (estTokens(text) <= opts.budgetTokens) return text;

  const lang = detectLanguage(opts.languageHint, text);
  if (lang === 'unknown') return text; // signal "unable to truncate structurally"

  const lines = text.split('\n');
  const { block: imports, consumedThrough } = extractImportBlock(lines, lang);
  const boundaries = findTopLevelBoundaries(lines, lang, consumedThrough + 1);

  // No detectable boundaries — keep imports + greedy-truncate the rest.
  if (boundaries.length === 0) {
    if (!imports) return text; // signal fallback
    const remaining = opts.budgetTokens - estTokens(imports) - estTokens(TRUNCATION_MARKER) - 2;
    if (remaining <= 0) return imports;
    const tailLines = lines.slice(consumedThrough + 1);
    const tail = tailLines.join('\n');
    if (estTokens(tail) <= remaining) return imports + '\n\n' + tail;
    const tailChars = Math.max(0, remaining * 4);
    return imports + '\n\n' + tail.slice(0, tailChars) + '\n\n' + TRUNCATION_MARKER.replace('N', '?');
  }

  const symbols = assembleSymbols(lines, boundaries);
  return packSymbols(imports, symbols, opts.budgetTokens, lang);
}

/**
 * Lightweight content-type detector used by callers to decide whether to
 * route through `structurallyTruncate` or fall back to prose middle-cut.
 *
 *   - `hint` is a free-form file name / path / extension hint (optional)
 *   - text body is sampled if no hint matches
 */
export function looksLikeCode(text: string, hint?: string): boolean {
  if (hint && /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs|py|go|rs|rust|java|kt|kts|cpp|cc|cxx|hpp|hh|c|h|rb|swift|cs|php|scala)$/i.test(hint)) {
    return true;
  }
  const sample = text.split('\n', 50);
  if (sample.length === 0) return false;
  const codeyRe = /^(import|export|from\s+\w+\s+import|function|class|def|fn\s|func\s|public\s|private\s|const\s|let\s|var\s|interface|type\s+\w+\s*=|use\s+\w|impl\s|struct\s|trait\s|enum\s|package\s)/;
  const codey = sample.filter((l) => codeyRe.test(l.trim())).length;
  return codey >= 3 || codey > sample.length * 0.2;
}
