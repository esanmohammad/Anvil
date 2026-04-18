/**
 * AST-aware code chunking with regex-based fallback.
 *
 * Splits source files in a repository into semantic CodeChunk objects at
 * function / class / method boundaries.  Uses a simple recursive directory
 * walker (no external glob dependency) and language-specific regex patterns.
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { join, relative, extname, basename, dirname } from 'node:path';
import type { CodeChunk } from './types';
import { SOURCE_EXTENSIONS, SKIP_DIRS, walkDir, langFromExt, extractImports } from './file-walker.js';

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
    default:
      return tsPatterns();
  }
}

function chunkId(filePath: string, startLine: number, endLine: number): string {
  return createHash('sha256')
    .update(`${filePath}${startLine}${endLine}`)
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
  const commentPrefix = lang === 'python' ? '#' : '//';
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
 * Splits at line boundaries, preserving as much context as possible.
 */
function splitOversizedContent(
  contentLines: string[],
  maxContentChars: number,
): string[] {
  const parts: string[] = [];
  let current: string[] = [];
  let currentLen = 0;

  for (const line of contentLines) {
    const lineLen = line.length + 1; // +1 for newline

    // If a single line exceeds the budget, hard-truncate it
    if (lineLen > maxContentChars) {
      if (current.length > 0) {
        parts.push(current.join('\n'));
        current = [];
        currentLen = 0;
      }
      parts.push(line.slice(0, maxContentChars));
      continue;
    }

    if (currentLen + lineLen > maxContentChars && current.length > 0) {
      parts.push(current.join('\n'));
      current = [];
      currentLen = 0;
    }
    current.push(line);
    currentLen += lineLen;
  }
  if (current.length > 0) {
    parts.push(current.join('\n'));
  }
  return parts;
}

function chunkFile(
  filePath: string,
  repoPath: string,
  repoName: string,
  project: string,
  maxTokens: number,
): CodeChunk[] {
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
  const boundaries: Array<{
    line: number;
    entityType: CodeChunk['entityType'];
    entityName: string | undefined;
  }> = [];

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

  const chunks: CodeChunk[] = [];

  const pushChunk = (
    content: string,
    startLine: number,
    endLine: number,
    entityType: CodeChunk['entityType'],
    entityName: string | undefined,
  ) => {
    const ctxContent = `${contextPrefix}\n${content}`;
    const tokens = Math.ceil(ctxContent.length / 4);
    const id = chunkId(relPath, startLine, endLine);
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
  ) => {
    const content = contentLines.join('\n');
    if (contextualizedTokens(contextPrefix, content) <= maxTokens) {
      pushChunk(content, startLine, startLine + contentLines.length - 1, entityType, entityName);
    } else {
      // Split oversized content into parts that fit
      const parts = splitOversizedContent(contentLines, maxContentChars);
      let lineOffset = startLine;
      for (let p = 0; p < parts.length; p++) {
        const partLines = parts[p].split('\n').length;
        const partName = entityName ? `${entityName}$${p + 1}` : undefined;
        pushChunk(parts[p], lineOffset, lineOffset + partLines - 1, entityType, partName);
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
    pushContentWithSplit(chunkLines, startLine + 1, boundaries[i].entityType, boundaries[i].entityName);
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
 * splits each source file at function/class/method boundaries using
 * language-specific regex patterns.
 *
 * When `cachedFiles` is provided, unchanged files (matching content hash)
 * are skipped — only new/modified files are chunked and returned.
 */
export async function chunkRepo(
  repoPath: string,
  repoName: string,
  project: string,
  config: { maxTokens: number },
  cachedFiles?: Record<string, FileIndexEntry>,
): Promise<ChunkResult> {
  const files: string[] = [];
  walkDir(repoPath, files);

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
    const chunks = chunkFile(file, repoPath, repoName, project, config.maxTokens);
    allChunks.push(...chunks);
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
 */
export async function chunkChangedFiles(
  repoPath: string,
  repoName: string,
  project: string,
  config: { maxTokens: number },
  diff: { added: string[]; modified: string[]; deleted: string[] },
): Promise<ChunkResult> {
  const allChunks: CodeChunk[] = [];
  const changedFiles: string[] = [];
  const fileIndex: Record<string, FileIndexEntry> = {};

  // Only chunk added + modified files
  for (const relPath of [...diff.added, ...diff.modified]) {
    const fullPath = join(repoPath, relPath);
    if (!existsSync(fullPath)) continue;
    const ext = extname(fullPath);
    if (!SOURCE_EXTENSIONS.has(ext)) continue;

    let contents: string;
    try {
      contents = readFileSync(fullPath, 'utf-8');
    } catch { continue; }

    changedFiles.push(relPath);
    const contentHash = createHash('sha256').update(contents).digest('hex');
    const chunks = chunkFile(fullPath, repoPath, repoName, project, config.maxTokens);
    allChunks.push(...chunks);
    fileIndex[relPath] = { contentHash, chunkCount: chunks.length };
  }

  return {
    chunks: allChunks,
    changedFiles,
    deletedFiles: [...diff.deleted],
    fileIndex,
  };
}
