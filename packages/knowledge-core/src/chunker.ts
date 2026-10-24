/**
 * Code chunking at definition boundaries.
 *
 * Splits source files in a repository into semantic CodeChunk objects at
 * function / class / method (and JS/TS top-level variable) boundaries — taken
 * from tree-sitter for the languages it parses, else from language-specific
 * regex patterns. A definition's leading comments / decorators belong to its
 * chunk. Uses a simple recursive directory walker (no external glob dependency).
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, relative, extname, basename, dirname } from 'node:path';
import type { CodeChunk } from '@esankhan3/anvil-knowledge-core';
import { walkDir, langFromExt, extractImports, isSourceFile, isIgnoredPath } from './file-walker.js';
import { parseFile, supportedLanguages } from './tree-sitter-parser.js';
import type { TreeSitterEntity } from './tree-sitter-parser.js';

// ---------------------------------------------------------------------------
// Language → boundary patterns
// ---------------------------------------------------------------------------

interface BoundaryPattern {
  regex: RegExp;
  entityType: CodeChunk['entityType'];
  /** Extract the entity name from the matched line */
  nameExtractor: (line: string) => string | undefined;
}

function tsPatterns(): BoundaryPattern[] {
  return [
    {
      regex: /^export\s+function\s+/,
      entityType: 'function',
      nameExtractor: (l) => l.match(/^export\s+function\s+(\w+)/)?.[1],
    },
    {
      regex: /^export\s+class\s+/,
      entityType: 'class',
      nameExtractor: (l) => l.match(/^export\s+class\s+(\w+)/)?.[1],
    },
    {
      regex: /^export\s+const\s+/,
      entityType: 'function',
      nameExtractor: (l) => l.match(/^export\s+const\s+(\w+)/)?.[1],
    },
    {
      regex: /^function\s+/,
      entityType: 'function',
      nameExtractor: (l) => l.match(/^function\s+(\w+)/)?.[1],
    },
    {
      regex: /^class\s+/,
      entityType: 'class',
      nameExtractor: (l) => l.match(/^class\s+(\w+)/)?.[1],
    },
    {
      regex: /^interface\s+/,
      entityType: 'interface',
      nameExtractor: (l) => l.match(/^interface\s+(\w+)/)?.[1],
    },
    {
      regex: /^type\s+/,
      entityType: 'type',
      nameExtractor: (l) => l.match(/^type\s+(\w+)/)?.[1],
    },
  ];
}

function pyPatterns(): BoundaryPattern[] {
  return [
    {
      regex: /^def\s+/,
      entityType: 'function',
      nameExtractor: (l) => l.match(/^def\s+(\w+)/)?.[1],
    },
    {
      regex: /^class\s+/,
      entityType: 'class',
      nameExtractor: (l) => l.match(/^class\s+(\w+)/)?.[1],
    },
    {
      regex: /^async\s+def\s+/,
      entityType: 'function',
      nameExtractor: (l) => l.match(/^async\s+def\s+(\w+)/)?.[1],
    },
  ];
}

function goPatterns(): BoundaryPattern[] {
  return [
    {
      regex: /^func\s+/,
      entityType: 'function',
      nameExtractor: (l) => l.match(/^func\s+(?:\([^)]*\)\s+)?(\w+)/)?.[1],
    },
    {
      regex: /^type\s+\w+\s+struct/,
      entityType: 'class',
      nameExtractor: (l) => l.match(/^type\s+(\w+)\s+struct/)?.[1],
    },
    {
      regex: /^type\s+\w+\s+interface/,
      entityType: 'interface',
      nameExtractor: (l) => l.match(/^type\s+(\w+)\s+interface/)?.[1],
    },
  ];
}

function rsPatterns(): BoundaryPattern[] {
  return [
    {
      regex: /^(pub\s+)?fn\s+/,
      entityType: 'function',
      nameExtractor: (l) => l.match(/fn\s+(\w+)/)?.[1],
    },
    {
      regex: /^(pub\s+)?struct\s+/,
      entityType: 'class',
      nameExtractor: (l) => l.match(/struct\s+(\w+)/)?.[1],
    },
    {
      regex: /^impl\s+/,
      entityType: 'class',
      nameExtractor: (l) => l.match(/^impl\s+(?:<[^>]+>\s+)?(\w+)/)?.[1],
    },
    {
      regex: /^(pub\s+)?trait\s+/,
      entityType: 'interface',
      nameExtractor: (l) => l.match(/trait\s+(\w+)/)?.[1],
    },
    {
      regex: /^(pub\s+)?enum\s+/,
      entityType: 'type',
      nameExtractor: (l) => l.match(/enum\s+(\w+)/)?.[1],
    },
  ];
}

function javaPatterns(): BoundaryPattern[] {
  return [
    {
      regex: /^public\s+class\s+/,
      entityType: 'class',
      nameExtractor: (l) => l.match(/class\s+(\w+)/)?.[1],
    },
    {
      regex: /^public\s+void\s+/,
      entityType: 'method',
      nameExtractor: (l) => l.match(/void\s+(\w+)/)?.[1],
    },
    {
      regex: /^private\s+void\s+/,
      entityType: 'method',
      nameExtractor: (l) => l.match(/void\s+(\w+)/)?.[1],
    },
    {
      regex: /^public\s+static\s+/,
      entityType: 'method',
      nameExtractor: (l) => l.match(/static\s+\w+\s+(\w+)/)?.[1],
    },
  ];
}

function patternsForLanguage(lang: string): BoundaryPattern[] {
  switch (lang) {
    case 'typescript':
    case 'javascript':
      return tsPatterns();
    case 'python':
      return pyPatterns();
    case 'go':
      return goPatterns();
    case 'rust':
      return rsPatterns();
    case 'java':
      return javaPatterns();
    case 'yaml':
    case 'hcl':
    case 'toml':
      // Config formats have no entity boundaries — whole-file module chunk.
      return [];
    default:
      return tsPatterns();
  }
}

/** Bump when chunk ids change scheme or chunk boundaries change: buildKB
 *  re-chunks (never skips or carries forward) a repo whose index_meta records
 *  another version, so an existing index picks up the new chunking without
 *  waiting for each file to change. Chunks whose text is unchanged keep their
 *  vectors (same id, or reuse by content hash). 2 = repo-scoped ids;
 *  3 = JS/TS top-level variables and nested-definition split points. */
export const CHUNK_ID_VERSION = 3;

/** Ids are unique per project: the same path + line range in two repos must
 *  not collide, and fields are separated so (a.ts, 1, 23) ≠ (a.ts, 12, 3). */
function chunkId(repoName: string, filePath: string, startLine: number, endLine: number): string {
  return createHash('sha256')
    .update(`${repoName}\0${filePath}\0${startLine}\0${endLine}`)
    .digest('hex')
    .slice(0, 16);
}

/** Detect exported symbols in a chunk. */
function extractExports(content: string, lang: string): string[] {
  const exports: string[] = [];
  if (lang === 'typescript' || lang === 'javascript') {
    const re = /export\s+(?:default\s+)?(?:function|class|const|let|var|interface|type|enum)\s+(\w+)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      exports.push(m[1]);
    }
  }
  return exports;
}

/** Build a structural context prefix for a chunk. Capped to stay within budget. */
function buildContextPrefix(
  relPath: string,
  lang: string,
  imports: string[],
): string {
  const commentPrefix = ['python', 'shell', 'yaml', 'toml', 'hcl'].includes(lang) ? '#' : '//';
  const moduleName = dirname(relPath).split('/').filter(Boolean).pop() ?? basename(relPath);
  const lines = [
    `${commentPrefix} File: ${relPath}`,
    `${commentPrefix} Module: ${moduleName}`,
  ];
  if (imports.length > 0) {
    // Cap imports to keep prefix under ~200 chars — the rest of the budget is for content
    const maxImportChars = 150;
    const importStr = imports.join(', ');
    const capped = importStr.length > maxImportChars
      ? importStr.slice(0, maxImportChars) + '...'
      : importStr;
    lines.push(`${commentPrefix} Imports: ${capped}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Chunk a single file
// ---------------------------------------------------------------------------

/**
 * Estimate tokens for the full contextualized content (prefix + content).
 * This is what actually gets sent to the embedding model.
 */
function contextualizedTokens(contextPrefix: string, content: string): number {
  return Math.ceil((contextPrefix.length + 1 + content.length) / 4);
}

/**
 * Split oversized content into sub-chunks that fit within maxTokens.
 * Splits at line boundaries, preserving as much context as possible. A part
 * that overflows ends before the last of its `cuts` lines (indices where a
 * nested definition starts) when it holds one, so the next part starts there.
 */
function splitOversizedContent(
  contentLines: string[],
  maxContentChars: number,
  cuts: Set<number> = new Set(),
): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let currentLen = 0;
  let start = 0; // index of current[0]

  for (let i = 0; i < contentLines.length; i++) {
    const line = contentLines[i];
    const lineLen = line.length + 1; // +1 for newline

    // If a single line exceeds the budget, hard-truncate it
    if (lineLen > maxContentChars) {
      if (current.length > 0) {
        parts.push(current.join('\n'));
        current = [];
        currentLen = 0;
      }
      parts.push(line.slice(0, maxContentChars));
      start = i + 1;
      continue;
    }

    while (currentLen + lineLen > maxContentChars && current.length > 0) {
      let cut = i;
      for (let c = i; c > start; c--) if (cuts.has(c)) { cut = c; break; }
      parts.push(current.slice(0, cut - start).join('\n'));
      current = current.slice(cut - start);
      currentLen = current.reduce((n, l) => n + l.length + 1, 0);
      start = cut;
    }
    current.push(line);
    currentLen += lineLen;
  }
  if (current.length > 0) {
    parts.push(current.join('\n'));
  }
  return parts;
}

interface Boundary {
  line: number; // 0-based
  entityType: CodeChunk['entityType'];
  entityName: string | undefined;
  parentEntity?: string;
}

const TREE_SITTER_LANGS = new Set(supportedLanguages());

const CHUNK_TYPE: Record<TreeSitterEntity['type'], CodeChunk['entityType']> = {
  function: 'function', method: 'method', class: 'class', interface: 'interface', type: 'type',
  struct: 'class', enum: 'type', trait: 'interface', module: 'class', const: 'const',
};

/** Definition boundaries from tree-sitter: top-level definitions (JS/TS
 *  top-level variables included) and class members. A definition inside a
 *  function body (named or anonymous) or a top-level variable is not a
 *  boundary; a nested function / method comes back in `nested`, where an
 *  oversized parent is split. null when the language isn't parsed or the
 *  parse yields nothing (→ regex boundaries). */
async function treeSitterBoundaries(
  filePath: string, content: string, lang: string, ext: string,
): Promise<{ boundaries: Boundary[]; nested: Boundary[] } | null> {
  const grammar = ext === '.tsx' ? 'tsx' : lang;
  if (!TREE_SITTER_LANGS.has(grammar)) return null;
  const parsed = await parseFile(filePath, content, grammar).catch(() => null);
  if (!parsed || parsed.entities.length === 0) return null;
  const consts = parsed.entities.filter((e) => e.type === 'const');
  const isNested = (e: TreeSitterEntity) =>
    e.local || consts.some((c) => c !== e && c.startByte <= e.startByte && e.endByte <= c.endByte);
  const top = new Map<number, Boundary>();
  const nested = new Map<number, Boundary>();
  for (const e of parsed.entities) {
    const into = !isNested(e) ? top : e.type === 'function' || e.type === 'method' ? nested : undefined;
    if (!into || into.has(e.startLine)) continue;
    into.set(e.startLine, { line: e.startLine, entityType: CHUNK_TYPE[e.type], entityName: e.name, parentEntity: e.parent });
  }
  const sorted = (byLine: Map<number, Boundary>) => [...byLine.values()].sort((a, b) => a.line - b.line);
  return { boundaries: sorted(top), nested: sorted(nested) };
}

/** Comment, doc-comment, decorator and attribute lines directly above a
 *  definition (no blank line between) belong to it. */
const LEADING_ANNOTATION = /^(\/\/|\/\*|\*|#|@)/;

async function chunkFile(
  filePath: string,
  repoPath: string,
  repoName: string,
  project: string,
  maxTokens: number,
): Promise<CodeChunk[]> {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf-8');
  } catch {
    return [];
  }

  const relPath = relative(repoPath, filePath);
  const ext = extname(filePath);
  const lang = langFromExt(ext);
  const lines = raw.split('\n');
  const patterns = patternsForLanguage(lang);
  const fileImports = extractImports(lines, lang);
  const contextPrefix = buildContextPrefix(relPath, lang, fileImports);

  // Reserve tokens for the context prefix so content fits within model context
  const prefixTokens = Math.ceil(contextPrefix.length / 4) + 1;
  const maxContentTokens = maxTokens - prefixTokens;
  const maxContentChars = maxContentTokens * 4;

  // Find boundary line indices
  const parsed = await treeSitterBoundaries(filePath, raw, lang, ext);
  let boundaries = parsed?.boundaries;
  const nested = parsed?.nested ?? [];
  if (!boundaries) {
    boundaries = [];
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trimStart();
      for (const pat of patterns) {
        if (pat.regex.test(trimmed)) {
          boundaries.push({
            line: i,
            entityType: pat.entityType,
            entityName: pat.nameExtractor(trimmed),
          });
          break;
        }
      }
    }
  }
  // Pull each boundary (and nested definition) up over its leading
  // annotations (never past the previous one).
  for (const list of [boundaries, nested]) {
    for (let b = 0; b < list.length; b++) {
      const floor = b > 0 ? list[b - 1].line + 1 : 0;
      while (list[b].line > floor && LEADING_ANNOTATION.test(lines[list[b].line - 1].trimStart())) {
        list[b].line--;
      }
    }
  }

  const chunks: CodeChunk[] = [];

  const pushChunk = (
    content: string,
    startLine: number,
    endLine: number,
    entityType: CodeChunk['entityType'],
    entityName: string | undefined,
    parentEntity?: string,
  ) => {
    const ctxContent = `${contextPrefix}\n${content}`;
    const tokens = Math.ceil(ctxContent.length / 4);
    const id = chunkId(repoName, relPath, startLine, endLine);
    chunks.push({
      id,
      filePath: relPath,
      repoName,
      project,
      startLine,
      endLine,
      content,
      contextPrefix,
      contextualizedContent: ctxContent,
      language: lang,
      entityType,
      entityName,
      ...(parentEntity ? { parentEntity } : {}),
      tokens,
      imports: fileImports,
      exports: extractExports(content, lang),
    });
  };

  const pushContentWithSplit = (
    contentLines: string[],
    startLine: number,
    entityType: CodeChunk['entityType'],
    entityName: string | undefined,
    parentEntity?: string,
  ) => {
    const content = contentLines.join('\n');
    if (contextualizedTokens(contextPrefix, content) <= maxTokens) {
      pushChunk(content, startLine, startLine + contentLines.length - 1, entityType, entityName, parentEntity);
    } else {
      // Split oversized content into parts that fit, starting parts at nested
      // definitions where possible: such a part is named after its definition,
      // parented to this entity; any other part is `name$<part number>`.
      const first = startLine - 1;
      const defAt = new Map(nested
        .filter((n) => n.line > first && n.line < first + contentLines.length)
        .map((n) => [n.line - first, n]));
      const parts = splitOversizedContent(contentLines, maxContentChars, new Set(defAt.keys()));
      let lineOffset = startLine;
      for (let p = 0; p < parts.length; p++) {
        const partLines = parts[p].split('\n').length;
        const def = defAt.get(lineOffset - startLine);
        if (def) {
          pushChunk(parts[p], lineOffset, lineOffset + partLines - 1, def.entityType, def.entityName, entityName);
        } else {
          const partName = entityName ? `${entityName}$${p + 1}` : undefined;
          pushChunk(parts[p], lineOffset, lineOffset + partLines - 1, entityType, partName, parentEntity);
        }
        lineOffset += partLines;
      }
    }
  };

  // If no boundaries found, treat entire file as one (possibly split) chunk
  if (boundaries.length === 0) {
    pushContentWithSplit(lines, 1, 'module', basename(filePath, ext));
    return chunks;
  }

  // Leading content before the first boundary
  if (boundaries[0].line > 0) {
    const leadLines = lines.slice(0, boundaries[0].line);
    const content = leadLines.join('\n').trimEnd();
    if (content.length > 0) {
      pushContentWithSplit(leadLines, 1, 'import', undefined);
    }
  }

  // Build chunks between boundaries
  for (let i = 0; i < boundaries.length; i++) {
    const startLine = boundaries[i].line;
    const endLine = i + 1 < boundaries.length ? boundaries[i + 1].line - 1 : lines.length - 1;
    const chunkLines = lines.slice(startLine, endLine + 1);
    pushContentWithSplit(chunkLines, startLine + 1, boundaries[i].entityType, boundaries[i].entityName, boundaries[i].parentEntity);
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Per-file content-hash caching types
// ---------------------------------------------------------------------------

export interface FileIndexEntry {
  contentHash: string;
  chunkCount: number;
}

export interface ChunkResult {
  /** Chunks from changed/new files only (need embedding) */
  chunks: CodeChunk[];
  /** Relative paths of files that were new or modified */
  changedFiles: string[];
  /** Relative paths of files present in cache but no longer on disk */
  deletedFiles: string[];
  /** Updated per-file metadata for saving */
  fileIndex: Record<string, FileIndexEntry>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Chunk all source files in a repository into semantic CodeChunk objects.
 *
 * Walks the directory tree, skipping common non-source directories, and
 * splits each source file at its definition boundaries (see `chunkFile`).
 *
 * When `cachedFiles` is provided, unchanged files (matching content hash)
 * are skipped — only new/modified files are chunked and returned.
 */
export async function chunkRepo(
  repoPath: string,
  repoName: string,
  project: string,
  config: { maxTokens: number; ignorePatterns?: string[] },
  cachedFiles?: Record<string, FileIndexEntry>,
  onChunk?: (chunk: CodeChunk) => void,
): Promise<ChunkResult> {
  const files: string[] = [];
  walkDir(repoPath, files, new Set(config.ignorePatterns));

  // When a sink is provided, stream each chunk to it and NEVER accumulate the
  // full array: at org scale a single big repo (e.g. 8k+ files) produces a
  // multi-GB chunk set, and under the worker-pool concurrency that footprint,
  // multiplied per lane, OOMs the prep phase. With a sink, `chunks` stays [].
  const allChunks: CodeChunk[] = [];
  const changedFiles: string[] = [];
  const fileIndex: Record<string, FileIndexEntry> = {};
  const currentFilePaths = new Set<string>();

  for (const file of files) {
    const relPath = relative(repoPath, file);
    currentFilePaths.add(relPath);

    // Compute content hash for cache comparison
    let contents: string;
    try {
      contents = readFileSync(file, 'utf-8');
    } catch {
      continue;
    }
    const contentHash = createHash('sha256').update(contents).digest('hex');

    // Check cache — skip chunking if file is unchanged
    if (cachedFiles?.[relPath]?.contentHash === contentHash) {
      fileIndex[relPath] = cachedFiles[relPath];
      continue;
    }

    // File is new or changed — chunk it
    changedFiles.push(relPath);
    const chunks = await chunkFile(file, repoPath, repoName, project, config.maxTokens);
    if (onChunk) { for (const c of chunks) onChunk(c); } else { allChunks.push(...chunks); }
    fileIndex[relPath] = { contentHash, chunkCount: chunks.length };
  }

  // Detect deleted files (in cache but no longer on disk)
  const deletedFiles: string[] = [];
  if (cachedFiles) {
    for (const path of Object.keys(cachedFiles)) {
      if (!currentFilePaths.has(path)) {
        deletedFiles.push(path);
      }
    }
  }

  return { chunks: allChunks, changedFiles, deletedFiles, fileIndex };
}

// ---------------------------------------------------------------------------
// Incremental chunking — only chunk files identified by git diff
// ---------------------------------------------------------------------------

/**
 * Chunk only the files that git diff identified as changed.
 * Much faster than chunkRepo() which iterates ALL files.
 *
 * The returned `fileIndex` covers the whole repo: `cachedFiles` (the previous
 * index) minus the diffed paths, plus the re-chunked ones — so it stays the
 * complete file list a later full re-chunk diffs against.
 */
export async function chunkChangedFiles(
  repoPath: string,
  repoName: string,
  project: string,
  config: { maxTokens: number; ignorePatterns?: string[] },
  diff: { added: string[]; modified: string[]; deleted: string[] },
  onChunk?: (chunk: CodeChunk) => void,
  cachedFiles?: Record<string, FileIndexEntry>,
): Promise<ChunkResult> {
  const ignore = new Set(config.ignorePatterns);
  const allChunks: CodeChunk[] = [];
  const changedFiles: string[] = [];
  const fileIndex: Record<string, FileIndexEntry> = { ...cachedFiles };
  for (const relPath of [...diff.added, ...diff.modified, ...diff.deleted]) delete fileIndex[relPath];

  // Only chunk added + modified files
  for (const relPath of [...diff.added, ...diff.modified]) {
    const fullPath = join(repoPath, relPath);
    if (!existsSync(fullPath)) continue;
    if (!isSourceFile(basename(fullPath)) || isIgnoredPath(relPath, ignore)) continue;

    let contents: string;
    try {
      contents = readFileSync(fullPath, 'utf-8');
    } catch { continue; }

    changedFiles.push(relPath);
    const contentHash = createHash('sha256').update(contents).digest('hex');
    const chunks = await chunkFile(fullPath, repoPath, repoName, project, config.maxTokens);
    if (onChunk) { for (const c of chunks) onChunk(c); } else { allChunks.push(...chunks); }
    fileIndex[relPath] = { contentHash, chunkCount: chunks.length };
  }

  return {
    chunks: allChunks,
    changedFiles,
    deletedFiles: [...diff.deleted],
    fileIndex,
  };
}
