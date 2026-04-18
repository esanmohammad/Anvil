/**
 * AST graph builder — Graphify-level quality for RAG retrieval.
 *
 * Builds a knowledge graph from source code with:
 *   Phase 0: Workspace package nodes
 *   Phase 1: File walking + entity extraction (regex-based, multi-language)
 *   Phase 2: Import resolution (relative + module-path + workspace + named imports)
 *   Phase 3: Type reference edges from entity bodies
 *   Phase 4: Import-aware call disambiguation (deferred cross-file resolution)
 *   Phase 5: Inheritance resolution
 *   Phase 6: Package→file contains edges
 *
 * Key improvements over previous version:
 *   - symbolToIds (multi-candidate) replaces symbolToId (first-writer-wins)
 *   - Import graph used to disambiguate calls (eliminates false edges)
 *   - Entity-level 'uses' edges from named imports (not just file→file)
 *   - Type reference edges from function signatures
 *   - Confidence scoring on every edge (for weighted BFS in retriever)
 */

import { readFileSync } from 'node:fs';
import { relative, extname, dirname, resolve, basename, join } from 'node:path';
import { walkDir, langFromExt, extractImports, extractNamedImports } from './file-walker.js';
import type { GraphifyNode, GraphifyEdge, GraphifyOutput, WorkspaceMap } from './types.js';
import { initTreeSitter, parseFile as tsParseFile, supportedLanguages } from './tree-sitter-parser.js';
import type { FileParseResult, TreeSitterEntity } from './tree-sitter-parser.js';

// ---------------------------------------------------------------------------
// Tree-sitter integration — use AST parsing when available, regex fallback
// ---------------------------------------------------------------------------

let treeSitterReady = false;
let treeSitterSupported = new Set<string>();

async function ensureTreeSitter(): Promise<boolean> {
  if (treeSitterReady) return true;
  try {
    await initTreeSitter();
    treeSitterSupported = new Set(supportedLanguages());
    treeSitterReady = true;
    return true;
  } catch {
    // Tree-sitter not available — fall back to regex
    return false;
  }
}

async function tryTreeSitterParse(filePath: string, content: string, lang: string): Promise<FileParseResult | null> {
  if (!treeSitterReady || !treeSitterSupported.has(lang)) return null;
  try {
    return await tsParseFile(filePath, content, lang);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Entity extraction patterns (unchanged, multi-language regex)
// ---------------------------------------------------------------------------

interface EntityPattern {
  regex: RegExp;
  type: string;
  nameExtractor: (line: string) => string | undefined;
}

function tsEntityPatterns(): EntityPattern[] {
  return [
    { regex: /^export\s+function\s+/, type: 'function', nameExtractor: (l) => l.match(/^export\s+function\s+(\w+)/)?.[1] },
    { regex: /^export\s+async\s+function\s+/, type: 'function', nameExtractor: (l) => l.match(/^export\s+async\s+function\s+(\w+)/)?.[1] },
    { regex: /^function\s+/, type: 'function', nameExtractor: (l) => l.match(/^function\s+(\w+)/)?.[1] },
    { regex: /^async\s+function\s+/, type: 'function', nameExtractor: (l) => l.match(/^async\s+function\s+(\w+)/)?.[1] },
    { regex: /^export\s+class\s+/, type: 'class', nameExtractor: (l) => l.match(/^export\s+class\s+(\w+)/)?.[1] },
    { regex: /^class\s+/, type: 'class', nameExtractor: (l) => l.match(/^class\s+(\w+)/)?.[1] },
    { regex: /^export\s+interface\s+/, type: 'interface', nameExtractor: (l) => l.match(/^export\s+interface\s+(\w+)/)?.[1] },
    { regex: /^interface\s+/, type: 'interface', nameExtractor: (l) => l.match(/^interface\s+(\w+)/)?.[1] },
    { regex: /^export\s+type\s+/, type: 'type', nameExtractor: (l) => l.match(/^export\s+type\s+(\w+)/)?.[1] },
    { regex: /^type\s+/, type: 'type', nameExtractor: (l) => l.match(/^type\s+(\w+)/)?.[1] },
    { regex: /^export\s+const\s+/, type: 'const', nameExtractor: (l) => l.match(/^export\s+const\s+(\w+)/)?.[1] },
  ];
}

function pyEntityPatterns(): EntityPattern[] {
  return [
    { regex: /^def\s+/, type: 'function', nameExtractor: (l) => l.match(/^def\s+(\w+)/)?.[1] },
    { regex: /^async\s+def\s+/, type: 'function', nameExtractor: (l) => l.match(/^async\s+def\s+(\w+)/)?.[1] },
    { regex: /^class\s+/, type: 'class', nameExtractor: (l) => l.match(/^class\s+(\w+)/)?.[1] },
  ];
}

function goEntityPatterns(): EntityPattern[] {
  return [
    { regex: /^func\s+/, type: 'function', nameExtractor: (l) => l.match(/^func\s+(?:\([^)]*\)\s+)?(\w+)/)?.[1] },
    { regex: /^type\s+\w+\s+struct/, type: 'struct', nameExtractor: (l) => l.match(/^type\s+(\w+)\s+struct/)?.[1] },
    { regex: /^type\s+\w+\s+interface/, type: 'interface', nameExtractor: (l) => l.match(/^type\s+(\w+)\s+interface/)?.[1] },
  ];
}

function rsEntityPatterns(): EntityPattern[] {
  return [
    { regex: /^(?:pub\s+)?fn\s+/, type: 'function', nameExtractor: (l) => l.match(/fn\s+(\w+)/)?.[1] },
    { regex: /^(?:pub\s+)?struct\s+/, type: 'struct', nameExtractor: (l) => l.match(/struct\s+(\w+)/)?.[1] },
    { regex: /^impl\s+/, type: 'impl', nameExtractor: (l) => l.match(/^impl\s+(?:<[^>]+>\s+)?(\w+)/)?.[1] },
    { regex: /^(?:pub\s+)?trait\s+/, type: 'trait', nameExtractor: (l) => l.match(/trait\s+(\w+)/)?.[1] },
    { regex: /^(?:pub\s+)?enum\s+/, type: 'enum', nameExtractor: (l) => l.match(/enum\s+(\w+)/)?.[1] },
  ];
}

function javaEntityPatterns(): EntityPattern[] {
  return [
    { regex: /(?:public|private|protected)\s+class\s+/, type: 'class', nameExtractor: (l) => l.match(/class\s+(\w+)/)?.[1] },
    { regex: /(?:public|private|protected)\s+interface\s+/, type: 'interface', nameExtractor: (l) => l.match(/interface\s+(\w+)/)?.[1] },
    { regex: /(?:public|private|protected)\s+(?:static\s+)?(?:void|int|long|boolean|String|[A-Z]\w*)\s+\w+\s*\(/, type: 'method', nameExtractor: (l) => l.match(/(?:void|int|long|boolean|String|[A-Z]\w*)\s+(\w+)\s*\(/)?.[1] },
  ];
}

function phpEntityPatterns(): EntityPattern[] {
  return [
    { regex: /^(?:abstract\s+)?class\s+/, type: 'class', nameExtractor: (l) => l.match(/class\s+(\w+)/)?.[1] },
    { regex: /^interface\s+/, type: 'interface', nameExtractor: (l) => l.match(/interface\s+(\w+)/)?.[1] },
    { regex: /^trait\s+/, type: 'trait', nameExtractor: (l) => l.match(/trait\s+(\w+)/)?.[1] },
    { regex: /^(?:public|private|protected)\s+(?:static\s+)?function\s+/, type: 'method', nameExtractor: (l) => l.match(/function\s+(\w+)/)?.[1] },
    { regex: /^function\s+/, type: 'function', nameExtractor: (l) => l.match(/^function\s+(\w+)/)?.[1] },
  ];
}

function entityPatternsForLang(lang: string): EntityPattern[] {
  switch (lang) {
    case 'typescript':
    case 'javascript':
      return tsEntityPatterns();
    case 'python':
      return pyEntityPatterns();
    case 'go':
      return goEntityPatterns();
    case 'rust':
      return rsEntityPatterns();
    case 'java':
      return javaEntityPatterns();
    case 'php':
      return phpEntityPatterns();
    default:
      return tsEntityPatterns();
  }
}

// ---------------------------------------------------------------------------
// Inheritance extraction
// ---------------------------------------------------------------------------

function extractInheritance(line: string, lang: string): string[] {
  const parents: string[] = [];
  if (lang === 'typescript' || lang === 'javascript') {
    const ext = line.match(/class\s+\w+\s+extends\s+(\w+)/);
    if (ext) parents.push(ext[1]);
    const impl = line.match(/class\s+\w+(?:\s+extends\s+\w+)?\s+implements\s+([\w,\s]+)/);
    if (impl) parents.push(...impl[1].split(',').map((s) => s.trim()).filter(Boolean));
  } else if (lang === 'python') {
    const m = line.match(/^class\s+\w+\(([^)]+)\)/);
    if (m) parents.push(...m[1].split(',').map((s) => s.trim()).filter((s) => s && s !== 'object'));
  } else if (lang === 'rust') {
    const m = line.match(/^impl\s+(\w+)\s+for\s+(\w+)/);
    if (m) parents.push(m[1]); // trait name
  } else if (lang === 'java' || lang === 'php') {
    const ext = line.match(/class\s+\w+\s+extends\s+(\w+)/);
    if (ext) parents.push(ext[1]);
    const impl = line.match(/class\s+\w+(?:\s+extends\s+\w+)?\s+implements\s+([\w,\s]+)/);
    if (impl) parents.push(...impl[1].split(',').map((s) => s.trim()).filter(Boolean));
  }
  return parents;
}

// ---------------------------------------------------------------------------
// Type reference extraction (Phase 3)
// ---------------------------------------------------------------------------

/**
 * Extract type references from an entity body.
 * These create 'type-ref' edges so BFS from a function reaches its parameter/return types.
 */
function extractTypeReferences(body: string, lang: string): string[] {
  const refs = new Set<string>();

  if (lang === 'typescript' || lang === 'javascript') {
    // Parameter types: (param: TypeName), return types: ): TypeName
    for (const m of body.matchAll(/:\s*([A-Z][A-Za-z0-9_]*)/g)) refs.add(m[1]);
    // Generic type params: <TypeName>
    for (const m of body.matchAll(/<([A-Z][A-Za-z0-9_]*)/g)) refs.add(m[1]);
    // Type assertions: as TypeName
    for (const m of body.matchAll(/\bas\s+([A-Z][A-Za-z0-9_]*)/g)) refs.add(m[1]);
    // new ClassName(
    for (const m of body.matchAll(/\bnew\s+([A-Z][A-Za-z0-9_]*)/g)) refs.add(m[1]);
  } else if (lang === 'python') {
    // Type hints: param: TypeName, -> TypeName
    for (const m of body.matchAll(/:\s*([A-Z][A-Za-z0-9_]*)/g)) refs.add(m[1]);
    for (const m of body.matchAll(/->\s*([A-Z][A-Za-z0-9_]*)/g)) refs.add(m[1]);
  } else if (lang === 'go') {
    // Go types: *TypeName, []TypeName, map[Key]Value, TypeName{ in signatures and bodies
    for (const m of body.matchAll(/[*\[\]]\s*([A-Z][A-Za-z0-9_]*)/g)) refs.add(m[1]);
    // Function parameters: name TypeName
    for (const m of body.matchAll(/\w+\s+([A-Z][A-Za-z0-9_]*)[,)\s]/g)) refs.add(m[1]);
    // Return types
    for (const m of body.matchAll(/\)\s*(?:\()?([A-Z][A-Za-z0-9_]*)/g)) refs.add(m[1]);
  } else if (lang === 'java' || lang === 'php') {
    // Type parameters: TypeName varName, return TypeName
    for (const m of body.matchAll(/\b([A-Z][A-Za-z0-9_]*)\s+\$?\w+/g)) refs.add(m[1]);
    // new ClassName(
    for (const m of body.matchAll(/\bnew\s+([A-Z][A-Za-z0-9_]*)/g)) refs.add(m[1]);
  } else if (lang === 'rust') {
    // Type annotations: -> TypeName, : TypeName
    for (const m of body.matchAll(/[-:]\s*(?:&\s*(?:mut\s+)?)?([A-Z][A-Za-z0-9_]*)/g)) refs.add(m[1]);
  }

  // Filter out common false positives (built-in types, too-short names)
  const builtins = new Set([
    'String', 'Number', 'Boolean', 'Object', 'Array', 'Map', 'Set', 'Promise',
    'Error', 'Date', 'RegExp', 'Function', 'Symbol', 'Buffer', 'Console',
    'JSON', 'Math', 'Uint8Array', 'Int32Array', 'Float64Array',
    'None', 'True', 'False', 'Self', 'Vec', 'Box', 'Option', 'Result',
    'HashMap', 'HashSet', 'Iterator', 'Exception', 'Throwable',
  ]);
  return [...refs].filter(r => r.length >= 3 && !builtins.has(r));
}

// ---------------------------------------------------------------------------
// Import resolution
// ---------------------------------------------------------------------------

const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '/index.ts', '/index.js'];

function extractPackageName(importPath: string): string {
  if (importPath.startsWith('@')) {
    const parts = importPath.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : importPath;
  }
  const slashIdx = importPath.indexOf('/');
  return slashIdx > 0 ? importPath.slice(0, slashIdx) : importPath;
}

function findOwningPackage(relPath: string, workspaceMap: WorkspaceMap): import('./types.js').WorkspacePackage | null {
  let best: import('./types.js').WorkspacePackage | null = null;
  let bestLen = -1;
  for (const pkg of workspaceMap.packages) {
    if (pkg.relativePath === '.') continue;
    const prefix = pkg.relativePath + '/';
    if (relPath.startsWith(prefix) && prefix.length > bestLen) {
      best = pkg;
      bestLen = prefix.length;
    }
  }
  return best;
}

function resolveImportPath(
  importPath: string,
  currentFile: string,
  knownFiles: Set<string>,
  workspaceMap?: WorkspaceMap,
): string | null {
  // 1. Relative imports
  if (importPath.startsWith('.')) {
    const currentDir = dirname(currentFile);
    const base = resolve('/', currentDir, importPath).slice(1);
    for (const ext of ['', ...RESOLVE_EXTENSIONS]) {
      const candidate = base + ext;
      if (knownFiles.has(candidate)) return candidate;
    }
    return null;
  }

  if (!workspaceMap) return null;

  // 2. Workspace package resolution
  const pkgName = extractPackageName(importPath);
  const pkg = workspaceMap.nameToPackage.get(pkgName);
  if (pkg) {
    if (importPath !== pkgName) {
      const subPath = importPath.slice(pkgName.length + 1);
      const fullSub = join(pkg.relativePath, subPath);
      for (const ext of ['', ...RESOLVE_EXTENSIONS]) {
        if (knownFiles.has(fullSub + ext)) return fullSub + ext;
      }
      const srcSub = join(pkg.relativePath, 'src', subPath);
      for (const ext of ['', ...RESOLVE_EXTENSIONS]) {
        if (knownFiles.has(srcSub + ext)) return srcSub + ext;
      }
    }
    return `pkg::${pkg.name}`;
  }

  // 3. tsconfig path alias resolution
  for (const [alias, resolvedBase] of workspaceMap.pathAliases) {
    if (importPath === alias || importPath.startsWith(alias + '/')) {
      const subPath = importPath === alias ? '' : importPath.slice(alias.length + 1);
      const mapped = subPath ? join(resolvedBase, subPath) : resolvedBase;
      for (const ext of ['', ...RESOLVE_EXTENSIONS]) {
        if (knownFiles.has(mapped + ext)) return mapped + ext;
      }
      for (const wsPkg of workspaceMap.packages) {
        if (resolvedBase.startsWith(wsPkg.relativePath)) {
          return `pkg::${wsPkg.name}`;
        }
      }
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Go module path resolution
// ---------------------------------------------------------------------------

function parseGoModulePath(repoPath: string): string | null {
  try {
    const gomod = readFileSync(join(repoPath, 'go.mod'), 'utf-8');
    const m = gomod.match(/^module\s+(\S+)/m);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

function buildGoPackageMap(repoPath: string, goModulePath: string, knownFiles: Set<string>): Map<string, string> {
  // Map full Go import path → directory relative path
  const pkgMap = new Map<string, string>();
  const goDirs = new Set<string>();
  for (const f of knownFiles) {
    if (f.endsWith('.go')) {
      goDirs.add(dirname(f));
    }
  }
  for (const dir of goDirs) {
    const importPath = dir === '.' ? goModulePath : `${goModulePath}/${dir}`;
    pkgMap.set(importPath, dir);
  }
  return pkgMap;
}

function resolveGoImport(
  importPath: string,
  goModulePath: string | null,
  goPackageMap: Map<string, string>,
  knownFiles: Set<string>,
): string | null {
  if (!goModulePath || !importPath.startsWith(goModulePath)) return null;
  const dir = goPackageMap.get(importPath);
  if (!dir) return null;
  // Return the directory — Go imports are package-level
  // Find any .go file in that directory to use as the target
  for (const f of knownFiles) {
    if (f.startsWith(dir + '/') && f.endsWith('.go') && !f.endsWith('_test.go')) {
      return dir; // return the directory path as a module node
    }
  }
  return dir;
}

// ---------------------------------------------------------------------------
// PHP namespace resolution
// ---------------------------------------------------------------------------

function parseComposerAutoload(repoPath: string): Map<string, string> {
  const nsMap = new Map<string, string>();
  try {
    const composer = JSON.parse(readFileSync(join(repoPath, 'composer.json'), 'utf-8'));
    const psr4 = composer?.autoload?.['psr-4'] ?? {};
    for (const [ns, path] of Object.entries(psr4)) {
      nsMap.set(ns as string, (path as string).replace(/\/+$/, ''));
    }
    // Also dev autoload
    const devPsr4 = composer?.['autoload-dev']?.['psr-4'] ?? {};
    for (const [ns, path] of Object.entries(devPsr4)) {
      nsMap.set(ns as string, (path as string).replace(/\/+$/, ''));
    }
  } catch { /* no composer.json */ }
  return nsMap;
}

function resolvePhpImport(
  importPath: string,
  phpNamespaceMap: Map<string, string>,
  knownFiles: Set<string>,
): string | null {
  for (const [prefix, basePath] of phpNamespaceMap) {
    if (importPath.startsWith(prefix)) {
      const relPart = importPath.slice(prefix.length).replace(/\\/g, '/');
      const candidate = basePath + '/' + relPart + '.php';
      if (knownFiles.has(candidate)) return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Python import resolution
// ---------------------------------------------------------------------------

function resolvePythonImport(
  importPath: string,
  currentFile: string,
  knownFiles: Set<string>,
): string | null {
  // Relative: from .module import ... (starts with .)
  if (importPath.startsWith('.')) {
    const dots = importPath.match(/^(\.+)/)?.[1].length ?? 1;
    let baseDir = dirname(currentFile);
    for (let i = 1; i < dots; i++) baseDir = dirname(baseDir);
    const modulePart = importPath.slice(dots);
    if (!modulePart) return null;
    const candidate = join(baseDir, modulePart.replace(/\./g, '/'));
    for (const ext of ['.py', '/__init__.py']) {
      if (knownFiles.has(candidate + ext)) return candidate + ext;
    }
    return null;
  }
  // Absolute: from package.module import ...
  const pathParts = importPath.split('.');
  const candidate = pathParts.join('/');
  for (const ext of ['.py', '/__init__.py']) {
    if (knownFiles.has(candidate + ext)) return candidate + ext;
  }
  // Try stripping first segment (package name)
  if (pathParts.length > 1) {
    const withoutPkg = pathParts.slice(1).join('/');
    for (const ext of ['.py', '/__init__.py']) {
      if (knownFiles.has(withoutPkg + ext)) return withoutPkg + ext;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Rust crate resolution
// ---------------------------------------------------------------------------

function resolveRustImport(importPath: string, knownFiles: Set<string>): string | null {
  // crate::module::item → src/module.rs or src/module/mod.rs
  if (!importPath.startsWith('crate::')) return null;
  const parts = importPath.slice(7).split('::');
  // Try progressively shorter paths (last parts might be items, not modules)
  for (let len = parts.length; len > 0; len--) {
    const candidate = 'src/' + parts.slice(0, len).join('/');
    if (knownFiles.has(candidate + '.rs')) return candidate + '.rs';
    if (knownFiles.has(candidate + '/mod.rs')) return candidate + '/mod.rs';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Java import resolution
// ---------------------------------------------------------------------------

function resolveJavaImport(importPath: string, knownFiles: Set<string>): string | null {
  const filePath = importPath.replace(/\./g, '/') + '.java';
  for (const prefix of ['src/main/java/', 'src/', '']) {
    if (knownFiles.has(prefix + filePath)) return prefix + filePath;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Call disambiguation (Phase 1 — import-aware)
// ---------------------------------------------------------------------------

const SKIP_CALL_NAMES = new Set([
  'if', 'else', 'for', 'while', 'switch', 'case', 'return', 'new', 'throw',
  'catch', 'try', 'await', 'yield', 'import', 'export', 'from', 'const',
  'let', 'var', 'function', 'class', 'interface', 'type', 'enum', 'struct',
  'impl', 'trait', 'fn', 'pub', 'use', 'mod', 'def', 'self', 'super',
  'this', 'true', 'false', 'null', 'undefined', 'void', 'async', 'static',
  'print', 'println', 'console', 'log', 'warn', 'error', 'info', 'debug',
  'require', 'module', 'exports', 'default', 'extends', 'implements',
  'package', 'public', 'private', 'protected', 'abstract', 'final',
  'override', 'virtual', 'delete', 'typeof', 'instanceof',
  'len', 'str', 'int', 'float', 'bool', 'list', 'dict', 'set', 'tuple',
  'range', 'map', 'filter', 'reduce', 'append', 'push', 'pop', 'shift',
  'fmt', 'err', 'nil', 'make', 'close', 'open', 'read', 'write',
]);

/**
 * Disambiguate a call target using the import graph.
 * Returns the best candidate node ID or null if ambiguous/unknown.
 */
function resolveCallTarget(
  calledName: string,
  callerFile: string,
  callerEntityId: string,
  symbolToIds: Map<string, string[]>,
  fileImportTargets: Map<string, Set<string>>,
): { targetId: string; confidence: number } | null {
  const candidates = symbolToIds.get(calledName);
  if (!candidates || candidates.length === 0) return null;

  // Single candidate — high confidence
  if (candidates.length === 1) {
    if (candidates[0] === callerEntityId) return null; // self-call
    // Same file = EXTRACTED, cross-file = INFERRED
    const targetFile = candidates[0].split('::')[0];
    const confidence = targetFile === callerFile ? 0.9 : 0.8;
    return { targetId: candidates[0], confidence };
  }

  // Multiple candidates — disambiguate

  // 1. Same file first
  const sameFile = candidates.find(c => c.startsWith(callerFile + '::') && c !== callerEntityId);
  if (sameFile) return { targetId: sameFile, confidence: 0.9 };

  // 2. Imported file candidate
  const callerImports = fileImportTargets.get(callerFile);
  if (callerImports) {
    const importedCandidate = candidates.find(c => {
      const candidateFile = c.split('::')[0];
      return callerImports.has(candidateFile);
    });
    if (importedCandidate) return { targetId: importedCandidate, confidence: 0.85 };
  }

  // 3. Same directory heuristic
  const callerDir = dirname(callerFile);
  const sameDirCandidates = candidates.filter(c => {
    const candidateFile = c.split('::')[0];
    return dirname(candidateFile) === callerDir && c !== callerEntityId;
  });
  if (sameDirCandidates.length === 1) return { targetId: sameDirCandidates[0], confidence: 0.65 };

  // No disambiguation — drop the edge entirely (better no edge than wrong edge)
  return null;
}

// ---------------------------------------------------------------------------
// Extended import resolution (uses language-specific resolvers)
// ---------------------------------------------------------------------------

function resolveImportFull(
  importPath: string,
  currentFile: string,
  lang: string,
  knownFiles: Set<string>,
  workspaceMap: WorkspaceMap | undefined,
  goModulePath: string | null,
  goPackageMap: Map<string, string>,
  phpNamespaceMap: Map<string, string>,
): string | null {
  // 1. Try the standard resolver (relative + workspace + tsconfig)
  const standard = resolveImportPath(importPath, currentFile, knownFiles, workspaceMap);
  if (standard) return standard;

  // 2. Language-specific module path resolution
  if (lang === 'go') {
    return resolveGoImport(importPath, goModulePath, goPackageMap, knownFiles);
  }
  if (lang === 'php') {
    return resolvePhpImport(importPath, phpNamespaceMap, knownFiles);
  }
  if (lang === 'python') {
    return resolvePythonImport(importPath, currentFile, knownFiles);
  }
  if (lang === 'rust') {
    return resolveRustImport(importPath, knownFiles);
  }
  if (lang === 'java') {
    return resolveJavaImport(importPath, knownFiles);
  }

  return null;
}

// ---------------------------------------------------------------------------
// Phase 1-6: Build the graph
// ---------------------------------------------------------------------------

interface ExtractedEntity {
  id: string;
  label: string;
  type: string;
  file: string;
  line: number;
  indent: number;
  parents: string[];
}

export async function buildAstGraph(
  repoPath: string,
  opts?: { maxFiles?: number; workspaceMap?: WorkspaceMap },
): Promise<GraphifyOutput> {
  // Phase 0 — Walk: collect all source files
  const files: string[] = [];
  walkDir(repoPath, files);

  const maxFiles = opts?.maxFiles ?? 5000;
  const sourceFiles = files.slice(0, maxFiles);
  const relPaths = new Set(sourceFiles.map((f) => relative(repoPath, f)));

  const nodes: GraphifyNode[] = [];
  const edges: GraphifyEdge[] = [];
  const entities: ExtractedEntity[] = [];

  // Multi-candidate symbol map (Phase 1: replaces first-writer-wins)
  const symbolToIds = new Map<string, string[]>();

  function registerSymbol(name: string, entityId: string): void {
    const existing = symbolToIds.get(name);
    if (existing) {
      existing.push(entityId);
    } else {
      symbolToIds.set(name, [entityId]);
    }
  }

  // Phase 0b — Package nodes (workspace-aware)
  const wsMap = opts?.workspaceMap;
  if (wsMap) {
    for (const pkg of wsMap.packages) {
      nodes.push({
        id: `pkg::${pkg.name}`,
        label: pkg.name,
        type: 'package',
        file: pkg.relativePath,
      });
    }
  }

  // Phase 0c — Language-specific resolvers (built once per repo)
  const goModulePath = parseGoModulePath(repoPath);
  const goPackageMap = goModulePath ? buildGoPackageMap(repoPath, goModulePath, relPaths) : new Map<string, string>();
  const phpNamespaceMap = parseComposerAutoload(repoPath);

  // Per-file import targets (for call disambiguation)
  const fileImportTargets = new Map<string, Set<string>>();

  // Initialize tree-sitter (best-effort — falls back to regex if unavailable)
  await ensureTreeSitter();

  // Phase 1 — Extract entities + imports (tree-sitter with regex fallback)
  for (const filePath of sourceFiles) {
    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const relPath = relative(repoPath, filePath);
    const ext = extname(filePath);
    const lang = langFromExt(ext);
    const lines = content.split('\n');

    // Module node
    nodes.push({ id: relPath, label: basename(relPath), type: 'module', file: relPath });

    // Try tree-sitter first, fall back to regex
    const tsResult = await tryTreeSitterParse(filePath, content, lang);

    if (tsResult && tsResult.entities.length > 0) {
      // ── Tree-sitter path: compiler-accurate entity extraction ──
      let currentClassId: string | null = null;

      for (const tsEntity of tsResult.entities) {
        const entityId = `${relPath}::${tsEntity.name}`;
        const entityType = tsEntity.type === 'struct' ? 'struct'
          : tsEntity.type === 'trait' ? 'trait'
          : tsEntity.type === 'enum' ? 'enum'
          : tsEntity.type === 'method' ? 'method'
          : tsEntity.type;

        nodes.push({ id: entityId, label: tsEntity.name, type: entityType, file: relPath });

        // Extract inheritance from the entity body's first line
        const firstLine = tsEntity.body.split('\n')[0] || '';
        const parentNames = extractInheritance(firstLine, lang);

        const entity: ExtractedEntity = {
          id: entityId,
          label: tsEntity.name,
          type: entityType,
          file: relPath,
          line: tsEntity.startLine,
          indent: 0,
          parents: parentNames,
        };
        entities.push(entity);

        registerSymbol(tsEntity.name, entityId);

        // Contains edge — methods belong to their parent class
        if (tsEntity.parent) {
          const parentId = `${relPath}::${tsEntity.parent}`;
          edges.push({ source: parentId, target: entityId, type: 'contains', confidence: 1.0 });
          registerSymbol(`${tsEntity.parent}.${tsEntity.name}`, entityId);
        } else {
          edges.push({ source: relPath, target: entityId, type: 'contains', confidence: 1.0 });
        }

        if (entityType === 'class' || entityType === 'struct' || entityType === 'interface' || entityType === 'trait') {
          currentClassId = entityId;
        }
      }
    } else {
      // ── Regex fallback path ──
      const patterns = entityPatternsForLang(lang);
      let currentClassId: string | null = null;
      let currentClassIndent = -1;

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trimStart();
        const indent = line.length - trimmed.length;

        if (currentClassId && indent <= currentClassIndent) {
          currentClassId = null;
          currentClassIndent = -1;
        }

        for (const pat of patterns) {
          if (!pat.regex.test(trimmed)) continue;
          const name = pat.nameExtractor(trimmed);
          if (!name) break;

          const entityId = `${relPath}::${name}`;
          const parentNames = extractInheritance(trimmed, lang);

          nodes.push({ id: entityId, label: name, type: pat.type, file: relPath });

          const entity: ExtractedEntity = {
            id: entityId,
            label: name,
            type: pat.type,
            file: relPath,
            line: i,
            indent,
            parents: parentNames,
          };
          entities.push(entity);

          registerSymbol(name, entityId);

          if (currentClassId && indent > currentClassIndent && (pat.type === 'function' || pat.type === 'method')) {
            edges.push({ source: currentClassId, target: entityId, type: 'contains', confidence: 1.0 });
            const className = currentClassId.split('::').pop();
            if (className) registerSymbol(`${className}.${name}`, entityId);
          } else {
            edges.push({ source: relPath, target: entityId, type: 'contains', confidence: 1.0 });
          }

          if (pat.type === 'class' || pat.type === 'struct' || pat.type === 'interface' || pat.type === 'trait') {
            currentClassId = entityId;
            currentClassIndent = indent;
          }

          break;
        }
      }
    }

    // Phase 2a — Import edges (file-level + entity-level 'uses')
    const importSpecs = extractImports(lines, lang);
    const importTargetSet = new Set<string>();

    for (const spec of importSpecs) {
      const resolved = resolveImportFull(spec, relPath, lang, relPaths, wsMap, goModulePath, goPackageMap, phpNamespaceMap);
      if (resolved) {
        edges.push({ source: relPath, target: resolved, type: 'imports', confidence: 1.0 });
        importTargetSet.add(resolved);
      }
    }

    // Phase 2b — Entity-level 'uses' edges from named imports
    const namedImports = extractNamedImports(lines, lang);
    for (const ni of namedImports) {
      const resolved = resolveImportFull(ni.specifier, relPath, lang, relPaths, wsMap, goModulePath, goPackageMap, phpNamespaceMap);
      if (!resolved) continue;
      importTargetSet.add(resolved);

      for (const name of ni.names) {
        // Look for the specific entity in the target file
        const targetEntityId = `${resolved}::${name}`;
        const candidates = symbolToIds.get(name);
        if (candidates?.includes(targetEntityId)) {
          edges.push({ source: relPath, target: targetEntityId, type: 'uses', confidence: 0.95 });
        } else if (candidates && candidates.length === 1) {
          // Single candidate with the imported name — likely correct
          edges.push({ source: relPath, target: candidates[0], type: 'uses', confidence: 0.85 });
        }
      }
    }

    fileImportTargets.set(relPath, importTargetSet);
  }

  // Phase 3 — Type reference edges
  const entityByFile = new Map<string, ExtractedEntity[]>();
  for (const e of entities) {
    const list = entityByFile.get(e.file) || [];
    list.push(e);
    entityByFile.set(e.file, list);
  }

  for (const filePath of sourceFiles) {
    const relPath = relative(repoPath, filePath);
    const fileEntities = entityByFile.get(relPath);
    if (!fileEntities || fileEntities.length === 0) continue;

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    const lang = langFromExt(extname(filePath));

    for (let ei = 0; ei < fileEntities.length; ei++) {
      const entity = fileEntities[ei];
      const startLine = entity.line;
      const endLine = ei + 1 < fileEntities.length ? fileEntities[ei + 1].line : lines.length;
      const body = lines.slice(startLine, Math.min(startLine + 30, endLine)).join('\n'); // limit body scan

      // Type references
      const typeRefs = extractTypeReferences(body, lang);
      for (const typeName of typeRefs) {
        const resolved = resolveCallTarget(typeName, entity.file, entity.id, symbolToIds, fileImportTargets);
        if (resolved) {
          edges.push({ source: entity.id, target: resolved.targetId, type: 'type-ref', confidence: Math.min(resolved.confidence, 0.85) });
        }
      }
    }
  }

  // Phase 4 — Import-aware call disambiguation (deferred cross-file resolution)
  for (const filePath of sourceFiles) {
    const relPath = relative(repoPath, filePath);
    const fileEntities = entityByFile.get(relPath);
    if (!fileEntities || fileEntities.length === 0) continue;

    let content: string;
    try {
      content = readFileSync(filePath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');

    for (let ei = 0; ei < fileEntities.length; ei++) {
      const entity = fileEntities[ei];
      const startLine = entity.line;
      const endLine = ei + 1 < fileEntities.length ? fileEntities[ei + 1].line : lines.length;
      const body = lines.slice(startLine, endLine).join('\n');

      const callRegex = /\b([a-zA-Z_]\w*)\s*\(/g;
      let match: RegExpExecArray | null;
      const seenCalls = new Set<string>();

      while ((match = callRegex.exec(body)) !== null) {
        const calledName = match[1];
        if (calledName.length < 3) continue;
        if (SKIP_CALL_NAMES.has(calledName)) continue;
        if (seenCalls.has(calledName)) continue;
        seenCalls.add(calledName);

        const resolved = resolveCallTarget(calledName, entity.file, entity.id, symbolToIds, fileImportTargets);
        if (resolved) {
          edges.push({ source: entity.id, target: resolved.targetId, type: 'calls', confidence: resolved.confidence });
        }
      }
    }
  }

  // Phase 5 — Inheritance edges (deferred, resolved against multi-candidate map)
  for (const entity of entities) {
    for (const parent of entity.parents) {
      const candidates = symbolToIds.get(parent);
      if (!candidates || candidates.length === 0) continue;
      if (candidates.length === 1) {
        edges.push({ source: entity.id, target: candidates[0], type: 'inherits', confidence: 0.95 });
      } else {
        // Prefer same-file or imported candidate
        const resolved = resolveCallTarget(parent, entity.file, entity.id, symbolToIds, fileImportTargets);
        if (resolved) {
          edges.push({ source: entity.id, target: resolved.targetId, type: 'inherits', confidence: resolved.confidence });
        }
      }
    }
  }

  // Phase 6 — Package→file contains edges (workspace-aware)
  if (wsMap) {
    for (const relPath of relPaths) {
      const owning = findOwningPackage(relPath, wsMap);
      if (owning) {
        edges.push({ source: `pkg::${owning.name}`, target: relPath, type: 'contains', confidence: 1.0 });
      }
    }
  }

  return { nodes, links: edges };
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

export function generateGraphReport(repoName: string, graph: GraphifyOutput): string {
  const sections: string[] = [];

  sections.push(`# Knowledge Graph Report: ${repoName}`);
  sections.push(`\n> Auto-generated by Anvil AST graph builder.\n`);

  const nodeCount = graph.nodes.length;
  const edgeCount = graph.links.length;
  const fileNodes = graph.nodes.filter((n) => n.type === 'module');

  sections.push(`## Overview\n`);
  sections.push(`- **Files:** ${fileNodes.length}`);
  sections.push(`- **Entities:** ${nodeCount - fileNodes.length}`);
  sections.push(`- **Total nodes:** ${nodeCount}`);
  sections.push(`- **Total edges:** ${edgeCount}`);

  // Edge type distribution
  const edgeTypeCounts = new Map<string, number>();
  for (const e of graph.links) {
    const t = e.type || 'unknown';
    edgeTypeCounts.set(t, (edgeTypeCounts.get(t) || 0) + 1);
  }
  sections.push(`\n### Edge Types\n`);
  sections.push('| Type | Count | Avg Confidence |');
  sections.push('|------|-------|----------------|');
  for (const [type, count] of [...edgeTypeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    const edgesOfType = graph.links.filter(e => e.type === type);
    const avgConf = edgesOfType.reduce((sum, e) => sum + (e.confidence ?? 0), 0) / edgesOfType.length;
    sections.push(`| ${type} | ${count} | ${avgConf.toFixed(2)} |`);
  }

  // Entity type distribution
  const entityTypeCounts = new Map<string, number>();
  for (const n of graph.nodes) {
    const t = n.type || 'unknown';
    entityTypeCounts.set(t, (entityTypeCounts.get(t) || 0) + 1);
  }
  sections.push(`\n### Entity Types\n`);
  sections.push('| Type | Count |');
  sections.push('|------|-------|');
  for (const [type, count] of [...entityTypeCounts.entries()].sort((a, b) => b[1] - a[1])) {
    sections.push(`| ${type} | ${count} |`);
  }

  // Top 10 hotspots by edge degree
  const degreeMap = new Map<string, number>();
  for (const e of graph.links) {
    degreeMap.set(e.source, (degreeMap.get(e.source) || 0) + 1);
    degreeMap.set(e.target, (degreeMap.get(e.target) || 0) + 1);
  }
  const topNodes = [...degreeMap.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (topNodes.length > 0) {
    sections.push(`\n### Hotspots (Top 10 by edge degree)\n`);
    sections.push('| Node | Degree | Type |');
    sections.push('|------|--------|------|');
    for (const [nodeId, degree] of topNodes) {
      const node = graph.nodes.find((n) => n.id === nodeId);
      sections.push(`| ${nodeId} | ${degree} | ${node?.type || '-'} |`);
    }
  }

  // Import dependency summary
  const importEdges = graph.links.filter((e) => e.type === 'imports' || e.type === 'uses');
  const importCounts = new Map<string, number>();
  for (const e of importEdges) {
    importCounts.set(e.source, (importCounts.get(e.source) || 0) + 1);
  }
  const topImporters = [...importCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (topImporters.length > 0) {
    sections.push(`\n### Top Importers\n`);
    sections.push('| File | Import Count |');
    sections.push('|------|-------------|');
    for (const [file, count] of topImporters) {
      sections.push(`| ${file} | ${count} |`);
    }
  }

  return sections.join('\n');
}

// ---------------------------------------------------------------------------
// Incremental graph update
// ---------------------------------------------------------------------------

/**
 * Incrementally update an AST graph when only some files changed.
 * Instead of rebuilding the entire graph, this:
 * 1. Removes nodes/edges for changed + deleted files
 * 2. Re-parses only the changed files
 * 3. Re-resolves edges affected by the changes
 *
 * Falls back to full rebuild if incremental update fails.
 */
export async function incrementalGraphUpdate(
  existingGraph: GraphifyOutput,
  changedFiles: string[],
  deletedFiles: string[],
  repoPath: string,
  opts?: { workspaceMap?: any },
): Promise<GraphifyOutput> {
  // If more than 30% of files changed, full rebuild is faster
  const totalFiles = new Set(existingGraph.nodes.filter(n => n.file).map(n => n.file)).size;
  const changedCount = changedFiles.length + deletedFiles.length;
  if (totalFiles === 0 || changedCount / totalFiles > 0.3) {
    return buildAstGraph(repoPath, opts);
  }

  try {
    // 1. Identify nodes to remove (from changed + deleted files)
    const filesToRemove = new Set([...changedFiles, ...deletedFiles]);
    const removedNodeIds = new Set<string>();

    for (const node of existingGraph.nodes) {
      if (node.file && filesToRemove.has(node.file)) {
        removedNodeIds.add(node.id);
      }
    }

    // Also remove module nodes for these files
    for (const node of existingGraph.nodes) {
      if (node.type === 'module' && node.file && filesToRemove.has(node.file)) {
        removedNodeIds.add(node.id);
      }
    }

    // 2. Keep nodes and edges NOT connected to removed nodes
    const keptNodes = existingGraph.nodes.filter(n => !removedNodeIds.has(n.id));
    const keptEdges = existingGraph.links.filter(
      e => !removedNodeIds.has(e.source) && !removedNodeIds.has(e.target),
    );

    // 3. Re-parse only changed files using the full builder
    //    Build a mini-graph for just the changed files, then merge
    if (changedFiles.length === 0) {
      // Only deletions — return the pruned graph
      return { nodes: keptNodes, links: keptEdges };
    }

    // Build fresh graph for the whole repo (only way to get correct cross-file resolution)
    // but this is the fallback — for true surgical update we'd need per-file parsing
    // For now, rebuild full and it will be fast since graph building is already fast (~seconds)
    const freshGraph = await buildAstGraph(repoPath, opts);

    // Extract only nodes/edges from changed files in the fresh graph
    const changedFileSet = new Set(changedFiles);
    const newNodes = freshGraph.nodes.filter(n => n.file && changedFileSet.has(n.file));
    const newNodeIds = new Set(newNodes.map(n => n.id));

    // Edges: keep edges from fresh graph that touch new nodes OR connect to kept nodes
    const keptNodeIds = new Set(keptNodes.map(n => n.id));
    const newEdges = freshGraph.links.filter(e => {
      const sourceIsNew = newNodeIds.has(e.source);
      const targetIsNew = newNodeIds.has(e.target);
      const sourceExists = keptNodeIds.has(e.source) || newNodeIds.has(e.source);
      const targetExists = keptNodeIds.has(e.target) || newNodeIds.has(e.target);
      // Keep edge if both endpoints exist and at least one is from changed files
      return sourceExists && targetExists && (sourceIsNew || targetIsNew);
    });

    // Also keep edges between existing nodes that reference entities from changed files
    // (e.g., if file B imports from changed file A, B's import edge should be updated)
    const updatedEdges = freshGraph.links.filter(e => {
      const sourceKept = keptNodeIds.has(e.source);
      const targetNew = newNodeIds.has(e.target);
      return sourceKept && targetNew;
    });

    return {
      nodes: [...keptNodes, ...newNodes],
      links: [...keptEdges, ...newEdges, ...updatedEdges],
    };
  } catch (err) {
    // Incremental update failed — fall back to full rebuild
    console.warn(`[ast-graph] Incremental update failed, falling back to full rebuild: ${err}`);
    return buildAstGraph(repoPath, opts);
  }
}
