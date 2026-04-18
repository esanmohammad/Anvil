/**
 * WS-8: Query-Adaptive Fusion — Query Classifier
 *
 * Classifies search queries to determine optimal retrieval weights
 * across vector, BM25, and graph search strategies.
 */

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface QueryClassification {
  type: 'identifier' | 'natural-language' | 'mixed' | 'path' | 'error-code';
  weights: { vector: number; bm25: number; graph: number };
  shouldUseTrigram: boolean;
  explanation: string;
}

// ---------------------------------------------------------------------------
// Detection patterns
// ---------------------------------------------------------------------------

const CAMEL_CASE_RE = /[a-z][A-Z]/;
const SNAKE_CASE_RE = /[a-z]_[a-z]/;
const PASCAL_CASE_RE = /^[A-Z][a-z]+[A-Z]/;
const DOT_PATH_RE = /[a-zA-Z]\.[a-zA-Z]/;  // foo.bar (not numbers like 3.14)

const FILE_PATH_RE = /[/\\].*\.\w{1,5}$/;
const FILE_EXT_RE = /\.\w{1,5}$/;
const PATH_SEPARATOR_RE = /[/\\]/;

const HEX_CODE_RE = /0x[A-Fa-f0-9]+/;
const ERROR_PREFIX_RE = /\bERR_\w+/;
const NUMERIC_ERROR_RE = /\bE\d{4,}/;
const HTTP_STATUS_RE = /\b[1-5]\d{2}\b/;

const QUESTION_WORDS = new Set([
  'how', 'what', 'where', 'why', 'when', 'does', 'can', 'is',
  'should', 'which', 'who', 'explain', 'describe', 'show',
]);

// ---------------------------------------------------------------------------
// Weight presets
// ---------------------------------------------------------------------------

const WEIGHTS = {
  identifier:       { vector: 0.2,  bm25: 0.6,  graph: 0.2  },
  path:             { vector: 0.1,  bm25: 0.7,  graph: 0.2  },
  'error-code':     { vector: 0.1,  bm25: 0.7,  graph: 0.2  },
  'natural-language': { vector: 0.6, bm25: 0.2, graph: 0.2  },
  mixed:            { vector: 0.4,  bm25: 0.35, graph: 0.25 },
} as const;

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classify a search query and return optimal retrieval weights.
 *
 * Classification order matters: more specific patterns (file path, error code)
 * are checked before broader categories (identifier, natural language).
 */
export function classifyQuery(query: string): QueryClassification {
  const trimmed = query.trim();
  if (trimmed.length === 0) {
    return {
      type: 'natural-language',
      weights: { ...WEIGHTS['natural-language'] },
      shouldUseTrigram: false,
      explanation: 'Empty query treated as natural language',
    };
  }

  const words = trimmed.split(/\s+/);
  const wordCount = words.length;
  const firstWordLower = words[0].toLowerCase();

  // --- File path ---
  // Contains path separators and a file extension
  if (PATH_SEPARATOR_RE.test(trimmed) && FILE_EXT_RE.test(trimmed)) {
    return {
      type: 'path',
      weights: { ...WEIGHTS.path },
      shouldUseTrigram: true,
      explanation: `File path detected: contains path separator and file extension`,
    };
  }

  // --- Error code ---
  // HTTP status codes only matched in short queries to avoid false positives
  const hasHttpStatus = wordCount <= 3 && HTTP_STATUS_RE.test(trimmed);
  if (
    HEX_CODE_RE.test(trimmed) ||
    ERROR_PREFIX_RE.test(trimmed) ||
    NUMERIC_ERROR_RE.test(trimmed) ||
    hasHttpStatus
  ) {
    return {
      type: 'error-code',
      weights: { ...WEIGHTS['error-code'] },
      shouldUseTrigram: true,
      explanation: `Error code pattern detected in query`,
    };
  }

  // Detect code-like tokens and natural language signals
  const hasCodeIdentifier =
    CAMEL_CASE_RE.test(trimmed) ||
    SNAKE_CASE_RE.test(trimmed) ||
    PASCAL_CASE_RE.test(trimmed) ||
    DOT_PATH_RE.test(trimmed);

  const hasQuestionWord = QUESTION_WORDS.has(firstWordLower);
  const isLongPhrase = wordCount > 4;
  const hasNaturalLanguageSignals = hasQuestionWord || isLongPhrase;

  // --- Mixed ---
  // Contains both code identifiers and natural language signals
  if (hasCodeIdentifier && hasNaturalLanguageSignals) {
    return {
      type: 'mixed',
      weights: { ...WEIGHTS.mixed },
      shouldUseTrigram: true,
      explanation: `Mixed query: contains code identifiers and natural language`,
    };
  }

  // --- Identifier ---
  // Code-like patterns with few words
  if (hasCodeIdentifier || (wordCount <= 2 && !hasNaturalLanguageSignals)) {
    return {
      type: 'identifier',
      weights: { ...WEIGHTS.identifier },
      shouldUseTrigram: true,
      explanation: `Identifier query: ${
        hasCodeIdentifier
          ? 'code naming convention detected'
          : 'short query without natural language signals'
      }`,
    };
  }

  // --- Natural language (default) ---
  return {
    type: 'natural-language',
    weights: { ...WEIGHTS['natural-language'] },
    shouldUseTrigram: false,
    explanation: `Natural language query: ${
      hasQuestionWord
        ? 'starts with question word'
        : `${wordCount} words without code patterns`
    }`,
  };
}

// ---------------------------------------------------------------------------
// Scope Router — keyword-based repo relevance scoring
// ---------------------------------------------------------------------------

/**
 * Given repo profiles and a query, return the most relevant repo names.
 *
 * Uses simple keyword matching on repo descriptions, domains, and technologies.
 * Full vector-based routing comes later when profile embeddings are available.
 */
export function routeQueryToRepos(
  query: string,
  profiles: Array<{
    name: string;
    domain: string;
    description: string;
    technologies: string[];
  }>,
  opts?: { maxRepos?: number },
): string[] {
  if (profiles.length === 0) return [];

  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return profiles.map((p) => p.name);

  // Score each repo by keyword overlap
  const scored: Array<{ name: string; score: number }> = profiles.map((profile) => {
    const profileTokens = new Set([
      ...tokenize(profile.name),
      ...tokenize(profile.domain),
      ...tokenize(profile.description),
      ...profile.technologies.flatMap((t) => tokenize(t)),
    ]);

    let score = 0;
    for (const token of queryTokens) {
      if (profileTokens.has(token)) {
        score += 1;
      }
      // Partial match bonus: query token is a substring of a profile token
      // (e.g., "auth" matches "authentication")
      for (const pt of Array.from(profileTokens)) {
        if (pt !== token && pt.includes(token) && token.length >= 3) {
          score += 0.5;
        }
      }
    }

    // Normalize by query length for fair comparison
    return { name: profile.name, score: score / queryTokens.length };
  });

  // Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Determine cutoff
  const maxRepos = opts?.maxRepos;
  const topScore = scored[0].score;

  // If the best score is negligible, no repo is a strong match — return all
  if (topScore < 0.1) {
    return profiles.map((p) => p.name);
  }

  // Keep repos with a meaningful score (at least 30% of the top score)
  const threshold = topScore * 0.3;
  let relevant = scored.filter((s) => s.score >= threshold);

  // Apply maxRepos limit if specified
  if (maxRepos && relevant.length > maxRepos) {
    relevant = relevant.slice(0, maxRepos);
  }

  // Default behavior: if >10 repos, keep top 60%
  if (!maxRepos && profiles.length > 10) {
    const cap = Math.ceil(profiles.length * 0.6);
    if (relevant.length > cap) {
      relevant = relevant.slice(0, cap);
    }
  }

  // Safety net: never return empty if we have profiles
  if (relevant.length === 0) {
    return profiles.map((p) => p.name);
  }

  return relevant.map((r) => r.name);
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Tokenize a string into lowercase words, splitting on non-alphanumeric chars */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 2);  // drop single-char tokens
}
