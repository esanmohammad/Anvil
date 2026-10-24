/**
 * Tree-sitter AST parser — compiler-accurate entity extraction.
 *
 * Real AST parsing via web-tree-sitter (WASM). Supports TypeScript,
 * JavaScript, TSX, Go, Python, Rust, Java, and PHP.
 */

import type { Node as TSNode, QueryMatch, Tree as TSTree } from 'web-tree-sitter';
import { Parser as TSParser, Language as TSLanguage, Query as TSQuery } from 'web-tree-sitter';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TreeSitterEntity {
  name: string;
  /** `const` = a JS/TS top-level variable whose value isn't a function. */
  type: 'function' | 'class' | 'method' | 'interface' | 'type' | 'struct' | 'enum' | 'trait' | 'module' | 'const';
  startLine: number;     // 0-based
  endLine: number;       // 0-based
  startByte: number;
  endByte: number;
  parent?: string;       // containing class/struct name
  signature?: string;    // function signature (params + return type)
  isExported: boolean;
  local: boolean;        // inside a function body (named or anonymous)
  body: string;          // full source text of this entity
}

export interface TreeSitterImport {
  source: string;        // import path/module
  names: string[];       // imported names (empty = default/namespace import)
  startLine: number;
  isRelative: boolean;   // starts with './' or '../'
}

export interface TreeSitterCallSite {
  callee: string;        // function/method name being called
  startLine: number;
  containingEntity?: string;  // which entity contains this call
}

export interface TreeSitterTypeRef {
  name: string;          // referenced type (or JSX component / instantiated class) name
  qualifier?: string;    // package of a Go `pkg.Type`
  startLine: number;
  containingEntity?: string;  // which entity contains this reference
}

export interface FileParseResult {
  filePath: string;
  language: string;
  entities: TreeSitterEntity[];
  imports: TreeSitterImport[];
  callSites: TreeSitterCallSite[];
  typeReferences: TreeSitterTypeRef[];
}

// ---------------------------------------------------------------------------
// Grammar map and singleton state
// ---------------------------------------------------------------------------

const GRAMMAR_MAP: Record<string, string> = {
  typescript: 'tree-sitter-typescript.wasm',
  javascript: 'tree-sitter-javascript.wasm',
  tsx: 'tree-sitter-tsx.wasm',
  go: 'tree-sitter-go.wasm',
  python: 'tree-sitter-python.wasm',
  rust: 'tree-sitter-rust.wasm',
  java: 'tree-sitter-java.wasm',
  php: 'tree-sitter-php.wasm',
};

let parserReady = false;
const languageParsers = new Map<string, { parser: TSParser; lang: TSLanguage }>();

/** Initialize the Tree-sitter WASM runtime. Must be called before parsing. */
export async function initTreeSitter(): Promise<void> {
  if (parserReady) return;
  await TSParser.init();
  parserReady = true;
}

async function getParserAndLang(language: string): Promise<{ parser: TSParser; lang: TSLanguage } | null> {
  if (languageParsers.has(language)) return languageParsers.get(language)!;

  const wasmFile = GRAMMAR_MAP[language];
  if (!wasmFile) return null;

  try {
    // Grammars built for the web-tree-sitter ABI in use (14/15).
    const wasmPath = require.resolve(`@vscode/tree-sitter-wasm/wasm/${wasmFile}`);
    const lang = await TSLanguage.load(wasmPath);
    const parser = new TSParser();
    parser.setLanguage(lang);
    const entry = { parser, lang };
    languageParsers.set(language, entry);
    return entry;
  } catch (err) {
    // Callers fall back to regex extraction — say so once, or a broken grammar
    // silently degrades every graph.
    if (!grammarLoadWarned.has(language)) {
      grammarLoadWarned.add(language);
      console.error(`[knowledge-core] tree-sitter grammar for ${language} failed to load (${err instanceof Error ? err.message : String(err)}); using regex extraction`);
    }
    return null;
  }
}
const grammarLoadWarned = new Set<string>();

// ---------------------------------------------------------------------------
// Query patterns per language
// ---------------------------------------------------------------------------

interface LanguageQueries {
  entities: string;
  imports: string;
  calls: string;
  /** Type names a definition uses (`@type`); declaration names are dropped in code. */
  typeRefs: string;
}

/** JS/TS variables that define something: every top-level (or exported)
 *  `const` / `let` / `var`, and a function-valued one at any depth. */
const JS_VARIABLE_ENTITIES = `
    (program (lexical_declaration (variable_declarator name: (identifier) @name) @entity))
    (program (variable_declaration (variable_declarator name: (identifier) @name) @entity))
    (export_statement declaration: (lexical_declaration (variable_declarator name: (identifier) @name) @entity)) @export
    (export_statement declaration: (variable_declaration (variable_declarator name: (identifier) @name) @entity)) @export
    (variable_declarator name: (identifier) @name value: [(arrow_function) (function_expression)]) @entity
`;

/** A capitalised JSX tag is a component reference (lowercase = an HTML element). */
const JSX_TYPE_REFS = `
    (jsx_opening_element name: (identifier) @type (#match? @type "^[A-Z]"))
    (jsx_self_closing_element name: (identifier) @type (#match? @type "^[A-Z]"))
`;

const TS_QUERIES: LanguageQueries = {
  entities: `
    (function_declaration name: (identifier) @name) @entity
    (class_declaration name: (type_identifier) @name) @entity
    (interface_declaration name: (type_identifier) @name) @entity
    (type_alias_declaration name: (type_identifier) @name) @entity
    (enum_declaration name: (identifier) @name) @entity
    (method_definition name: (property_identifier) @name) @entity
    (export_statement declaration: (function_declaration name: (identifier) @name) @entity) @export
    (export_statement declaration: (class_declaration name: (type_identifier) @name) @entity) @export
    (export_statement declaration: (interface_declaration name: (type_identifier) @name) @entity) @export
    (export_statement declaration: (type_alias_declaration name: (type_identifier) @name) @entity) @export
    (export_statement declaration: (enum_declaration name: (identifier) @name) @entity) @export
    (ambient_declaration (lexical_declaration (variable_declarator name: (identifier) @name) @entity))
    (ambient_declaration (variable_declaration (variable_declarator name: (identifier) @name) @entity))
    (ambient_declaration (function_signature name: (identifier) @name) @entity)
    (statement_block (function_signature name: (identifier) @name) @entity)
    (statement_block (export_statement declaration: (function_signature name: (identifier) @name) @entity) @export)
    ${JS_VARIABLE_ENTITIES}
  `,
  imports: `
    (import_statement source: (string) @source) @import
    (call_expression function: (identifier) @_fn arguments: (arguments (string) @source) (#eq? @_fn "require")) @import
  `,
  calls: `
    (call_expression function: (identifier) @callee) @call
    (call_expression function: (member_expression property: (property_identifier) @callee)) @call
  `,
  typeRefs: `
    (type_identifier) @type
    (new_expression constructor: (identifier) @type)
    ${JSX_TYPE_REFS}
  `,
};

/** JavaScript: TS's queries minus the type-only nodes; class names are plain identifiers. */
const JS_QUERIES: LanguageQueries = {
  entities: `
    (function_declaration name: (identifier) @name) @entity
    (class_declaration name: (identifier) @name) @entity
    (method_definition name: (property_identifier) @name) @entity
    (export_statement declaration: (function_declaration name: (identifier) @name) @entity) @export
    (export_statement declaration: (class_declaration name: (identifier) @name) @entity) @export
    ${JS_VARIABLE_ENTITIES}
  `,
  imports: TS_QUERIES.imports,
  calls: TS_QUERIES.calls,
  typeRefs: `
    (new_expression constructor: (identifier) @type)
    ${JSX_TYPE_REFS}
  `,
};

const GO_QUERIES: LanguageQueries = {
  entities: `
    (function_declaration name: (identifier) @name) @entity
    (method_declaration name: (field_identifier) @name) @entity
    (type_declaration (type_spec name: (type_identifier) @name type: (struct_type))) @entity
    (type_declaration (type_spec name: (type_identifier) @name type: (interface_type))) @entity
  `,
  imports: `
    (import_spec path: (interpreted_string_literal) @source) @import
  `,
  calls: `
    (call_expression function: (identifier) @callee) @call
    (call_expression function: (selector_expression field: (field_identifier) @callee)) @call
  `,
  typeRefs: `
    (type_identifier) @type
  `,
};

const PY_QUERIES: LanguageQueries = {
  entities: `
    (function_definition name: (identifier) @name) @entity
    (class_definition name: (identifier) @name) @entity
  `,
  imports: `
    (import_from_statement module_name: (dotted_name) @source) @import
    (import_statement name: (dotted_name) @source) @import
  `,
  calls: `
    (call function: (identifier) @callee) @call
    (call function: (attribute attribute: (identifier) @callee)) @call
  `,
  typeRefs: `
    (type (identifier) @type)
  `,
};

const RUST_QUERIES: LanguageQueries = {
  entities: `
    (function_item name: (identifier) @name) @entity
    (struct_item name: (type_identifier) @name) @entity
    (impl_item type: (type_identifier) @name) @entity
    (trait_item name: (type_identifier) @name) @entity
    (enum_item name: (type_identifier) @name) @entity
  `,
  imports: `
    (use_declaration argument: (scoped_identifier) @source) @import
  `,
  calls: `
    (call_expression function: (identifier) @callee) @call
    (call_expression function: (field_expression field: (field_identifier) @callee)) @call
  `,
  typeRefs: `
    (type_identifier) @type
  `,
};

const JAVA_QUERIES: LanguageQueries = {
  entities: `
    (class_declaration name: (identifier) @name) @entity
    (interface_declaration name: (identifier) @name) @entity
    (method_declaration name: (identifier) @name) @entity
    (enum_declaration name: (identifier) @name) @entity
  `,
  imports: `
    (import_declaration (scoped_identifier) @source) @import
  `,
  calls: `
    (method_invocation name: (identifier) @callee) @call
  `,
  typeRefs: `
    (type_identifier) @type
  `,
};

const PHP_QUERIES: LanguageQueries = {
  entities: `
    (function_definition name: (name) @name) @entity
    (class_declaration name: (name) @name) @entity
    (method_declaration name: (name) @name) @entity
    (interface_declaration name: (name) @name) @entity
    (trait_declaration name: (name) @name) @entity
  `,
  imports: `
    (namespace_use_declaration (namespace_use_clause (qualified_name) @source)) @import
  `,
  calls: `
    (function_call_expression function: (name) @callee) @call
    (member_call_expression name: (name) @callee) @call
  `,
  typeRefs: `
    (named_type (name) @type)
    (object_creation_expression (name) @type)
  `,
};

function queriesForLanguage(language: string): LanguageQueries | null {
  switch (language) {
    case 'typescript':
    case 'tsx':
      return TS_QUERIES;
    case 'javascript':
      return JS_QUERIES;
    case 'go':
      return GO_QUERIES;
    case 'python':
      return PY_QUERIES;
    case 'rust':
      return RUST_QUERIES;
    case 'java':
      return JAVA_QUERIES;
    case 'php':
      return PHP_QUERIES;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Entity type detection from AST node types
// ---------------------------------------------------------------------------

type EntityType = TreeSitterEntity['type'];

const NODE_TYPE_TO_ENTITY: Record<string, EntityType> = {
  // TypeScript / JavaScript
  function_declaration: 'function',
  class_declaration: 'class',
  method_definition: 'method',
  interface_declaration: 'interface',
  type_alias_declaration: 'type',
  enum_declaration: 'enum',
  // Python
  function_definition: 'function',
  class_definition: 'class',
  // Go (type_spec handled separately via child type)
  // Rust
  function_item: 'function',
  struct_item: 'struct',
  impl_item: 'module',  // impl blocks act as module-level grouping
  trait_item: 'trait',
  enum_item: 'enum',
  // Java
  method_declaration: 'method',
  // PHP (uses same names as TS for class/interface + 'trait_declaration')
  function_definition_php: 'function',
  trait_declaration: 'trait',
};

function detectEntityType(node: TSNode, _language: string): EntityType {
  const t = node.type;

  // Direct mapping
  const mapped = NODE_TYPE_TO_ENTITY[t];
  if (mapped) return mapped;

  // JS/TS variable: a function when its value is one
  if (t === 'variable_declarator') {
    const value = node.childForFieldName('value')?.type;
    return value === 'arrow_function' || value === 'function_expression' ? 'function' : 'const';
  }

  // Go: type_declaration wrapping type_spec
  if (t === 'type_declaration' || t === 'type_spec') {
    const spec = t === 'type_declaration' ? node.namedChildren.find((c) => c.type === 'type_spec') : node;
    if (spec) {
      const typeChild = spec.namedChildren.find(
        (c) => c.type === 'struct_type' || c.type === 'interface_type',
      );
      if (typeChild?.type === 'struct_type') return 'struct';
      if (typeChild?.type === 'interface_type') return 'interface';
    }
    return 'type';
  }

  // Fallback heuristic based on language
  if (t.includes('class')) return 'class';
  if (t.includes('interface')) return 'interface';
  if (t.includes('method')) return 'method';
  if (t.includes('function') || t.includes('func')) return 'function';
  if (t.includes('struct')) return 'struct';
  if (t.includes('enum')) return 'enum';
  if (t.includes('trait')) return 'trait';

  return 'function'; // safe default
}

// ---------------------------------------------------------------------------
// Export detection
// ---------------------------------------------------------------------------

function isExported(entityNode: TSNode, language: string, content: string): boolean {
  // TS/JS: parent is export_statement
  if (language === 'typescript' || language === 'javascript' || language === 'tsx') {
    let cursor: TSNode | null = entityNode.parent;
    while (cursor) {
      if (cursor.type === 'export_statement') return true;
      cursor = cursor.parent;
    }
    return false;
  }

  // Rust: starts with 'pub'
  if (language === 'rust') {
    const text = content.slice(entityNode.startIndex, entityNode.startIndex + 10);
    return text.trimStart().startsWith('pub');
  }

  // Go: exported if name starts with uppercase
  if (language === 'go') {
    const nameChild = entityNode.namedChildren.find(
      (c) => c.type === 'identifier' || c.type === 'type_identifier' || c.type === 'field_identifier',
    );
    if (nameChild) {
      const name = nameChild.text;
      return name.length > 0 && name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase();
    }
    return false;
  }

  // Java: check for 'public' modifier
  if (language === 'java') {
    const modifiers = entityNode.namedChildren.find((c) => c.type === 'modifiers');
    if (modifiers) return modifiers.text.includes('public');
    return false;
  }

  // Python/PHP: no export concept — treat all top-level as exported
  return true;
}

// ---------------------------------------------------------------------------
// Containing entity (parent class/struct)
// ---------------------------------------------------------------------------

const FUNCTION_NODES = new Set([
  'function_declaration', 'function_definition', 'function_item', 'method_definition',
  'method_declaration', 'arrow_function', 'function_expression',
]);

/** Name of the class / impl a definition sits in directly — undefined when a
 *  function body comes first (a nested function is not a method). */
function enclosingClassName(node: TSNode): string | undefined {
  for (let cursor = node.parent; cursor; cursor = cursor.parent) {
    if (FUNCTION_NODES.has(cursor.type)) return undefined;
    if (cursor.type === 'class_definition' || cursor.type === 'impl_item') {
      return cursor.namedChildren.find((c) => c.type === 'identifier' || c.type === 'type_identifier')?.text;
    }
  }
  return undefined;
}

function isLocal(node: TSNode): boolean {
  for (let cursor = node.parent; cursor; cursor = cursor.parent) {
    if (FUNCTION_NODES.has(cursor.type)) return true;
  }
  return false;
}

function findContainingEntity(node: TSNode): string | undefined {
  let cursor: TSNode | null = node.parent;
  while (cursor) {
    const t = cursor.type;
    if (
      t === 'class_declaration' || t === 'class_definition' || t === 'class_body' ||
      t === 'impl_item' || t === 'struct_item' || t === 'trait_item' ||
      t === 'interface_declaration' || t === 'trait_declaration'
    ) {
      // If we landed on class_body, go up one more to the declaration
      const target = t === 'class_body' && cursor.parent ? cursor.parent : cursor;
      const nameChild = target.namedChildren.find(
        (c) => c.type === 'identifier' || c.type === 'type_identifier' || c.type === 'name',
      );
      if (nameChild) return nameChild.text;
    }
    cursor = cursor.parent;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Signature extraction
// ---------------------------------------------------------------------------

function extractSignature(entityNode: TSNode, entityType: EntityType, _content: string): string | undefined {
  if (entityType !== 'function' && entityType !== 'method') return undefined;

  // Find the parameters node
  const params = entityNode.namedChildren.find(
    (c) => c.type === 'formal_parameters' || c.type === 'parameters' ||
           c.type === 'parameter_list' || c.type === 'typed_parameters',
  );

  // Find return type annotation if present
  const returnType = entityNode.namedChildren.find(
    (c) => c.type === 'type_annotation' || c.type === 'return_type',
  );

  if (!params) return undefined;

  let sig = params.text;
  if (returnType) sig += `: ${returnType.text}`;
  return sig;
}

// ---------------------------------------------------------------------------
// Query execution with fallback
// ---------------------------------------------------------------------------

// Compiled once per (grammar, source): compiling is far costlier than matching,
// and every file of a language runs the same queries. null = doesn't compile.
const compiledQueries = new WeakMap<TSLanguage, Map<string, TSQuery | null>>();

function compiledQuery(language: TSLanguage, querySource: string): TSQuery | null {
  let byLang = compiledQueries.get(language);
  if (!byLang) compiledQueries.set(language, (byLang = new Map()));
  if (!byLang.has(querySource)) {
    try {
      byLang.set(querySource, new TSQuery(language, querySource));
    } catch {
      byLang.set(querySource, null); // syntax mismatch for this grammar version
    }
  }
  return byLang.get(querySource)!;
}

/**
 * Run a query. If the full query doesn't compile for this grammar (some
 * patterns name nodes it lacks), run each pattern that does individually.
 */
function runQueryWithFallback(
  language: TSLanguage,
  querySource: string,
  rootNode: TSNode,
): QueryMatch[] {
  const full = compiledQuery(language, querySource);
  if (full) return full.matches(rootNode);

  const patterns = querySource
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('('));

  const results: QueryMatch[] = [];
  for (const pattern of patterns) {
    const q = compiledQuery(language, pattern);
    if (q) results.push(...q.matches(rootNode));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Import parsing helpers
// ---------------------------------------------------------------------------

function parseImportMatches(
  matches: QueryMatch[],
  language: string,
  _content: string,
  _rootNode: TSNode,
): TreeSitterImport[] {
  const imports: TreeSitterImport[] = [];

  for (const match of matches) {
    const sourceCapture = match.captures.find((c) => c.name === 'source');
    const importCapture = match.captures.find((c) => c.name === 'import');
    if (!sourceCapture) continue;

    // Strip quotes from source
    let source = sourceCapture.node.text.replace(/^['"`]|['"`]$/g, '');
    const startLine = (importCapture ?? sourceCapture).node.startPosition.row;
    const isRelative = source.startsWith('./') || source.startsWith('../');

    // Extract named imports for TS/JS
    const names: string[] = [];
    if (language === 'typescript' || language === 'javascript' || language === 'tsx') {
      const importNode = importCapture?.node ?? sourceCapture.node.parent;
      if (importNode) {
        // Walk the import statement for import_clause → named_imports
        const walk = (n: TSNode) => {
          if (n.type === 'import_specifier') {
            const nameNode = n.namedChildren.find((c) => c.type === 'identifier');
            if (nameNode) names.push(nameNode.text);
          }
          if (n.type === 'identifier' && n.parent?.type === 'import_clause') {
            names.push(n.text); // default import
          }
          for (const child of n.namedChildren) walk(child);
        };
        walk(importNode);
      }
    }

    // Python: extract names from import_from_statement
    if (language === 'python') {
      const importNode = importCapture?.node ?? sourceCapture.node.parent;
      if (importNode && importNode.type === 'import_from_statement') {
        for (const child of importNode.namedChildren) {
          if (child.type === 'dotted_name' && child !== sourceCapture.node) {
            names.push(child.text);
          }
          if (child.type === 'aliased_import') {
            const nameNode = child.namedChildren.find((c) => c.type === 'dotted_name');
            if (nameNode) names.push(nameNode.text);
          }
        }
      }
    }

    imports.push({ source, names, startLine, isRelative });
  }

  return imports;
}

// ---------------------------------------------------------------------------
// Call site parsing
// ---------------------------------------------------------------------------

/** Innermost entity containing byte `at`: a call in a method belongs to the
 *  method, not to its class. */
function innermostEntity(entities: TreeSitterEntity[], at: number): string | undefined {
  let containingEntity: string | undefined;
  let span = Infinity;
  for (const e of entities) {
    if (at >= e.startByte && at < e.endByte && e.endByte - e.startByte < span) {
      containingEntity = e.name;
      span = e.endByte - e.startByte;
    }
  }
  return containingEntity;
}

function parseCallMatches(
  matches: QueryMatch[],
  entities: TreeSitterEntity[],
): TreeSitterCallSite[] {
  const callSites: TreeSitterCallSite[] = [];

  for (const match of matches) {
    const calleeCapture = match.captures.find((c) => c.name === 'callee');
    if (!calleeCapture) continue;

    const callee = calleeCapture.node.text;
    const startLine = calleeCapture.node.startPosition.row;
    callSites.push({ callee, startLine, containingEntity: innermostEntity(entities, calleeCapture.node.startIndex) });
  }

  return callSites;
}

// ---------------------------------------------------------------------------
// Type reference extraction
// ---------------------------------------------------------------------------

/** Containers whose type name is the last segment of a namespace-qualified
 *  name (`React.FC`, `java.util.List`), which bare-name resolution can't place.
 *  A Go `pkg.Type` (`qualified_type`) keeps its package as the qualifier. */
const QUALIFIED_TYPE_NODES = new Set(['nested_type_identifier', 'scoped_type_identifier']);

function parseTypeRefMatches(matches: QueryMatch[], entities: TreeSitterEntity[]): TreeSitterTypeRef[] {
  const refs: TreeSitterTypeRef[] = [];
  for (const match of matches) {
    const node = match.captures.find((c) => c.name === 'type')?.node;
    if (!node || BUILTIN_TYPES.has(node.text)) continue;
    const parent = node.parent;
    const qualifier = parent?.type === 'qualified_type' ? parent.childForFieldName('package')?.text : undefined;
    if (node.type === 'type_identifier' && parent && !qualifier) {
      // `class Foo`, `type Foo struct`, `<T>` declare a name rather than use one.
      if (parent.childForFieldName('name')?.equals(node) || QUALIFIED_TYPE_NODES.has(parent.type)) continue;
    }
    refs.push({
      name: node.text,
      ...(qualifier ? { qualifier } : {}),
      startLine: node.startPosition.row,
      containingEntity: innermostEntity(entities, node.startIndex),
    });
  }
  return refs;
}

const BUILTIN_TYPES = new Set([
  'String', 'Number', 'Boolean', 'Object', 'Array', 'Function', 'Symbol',
  'Promise', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Date', 'RegExp', 'Error',
  'Record', 'Partial', 'Required', 'Readonly', 'Pick', 'Omit', 'Exclude',
  'Extract', 'NonNullable', 'ReturnType', 'Parameters', 'InstanceType',
  'Awaited', 'Uint8Array', 'Int32Array', 'Float64Array', 'ArrayBuffer',
  'Iterator', 'AsyncIterator', 'Generator', 'AsyncGenerator',
]);

// ---------------------------------------------------------------------------
// Main parse function
// ---------------------------------------------------------------------------

/**
 * Parse a single source file using Tree-sitter AST parsing.
 *
 * Returns null for unsupported languages or parse failures.
 */
export async function parseFile(
  filePath: string,
  content: string,
  language: string,
): Promise<FileParseResult | null> {
  await initTreeSitter();

  const parserEntry = await getParserAndLang(language);
  if (!parserEntry) return null;

  const queries = queriesForLanguage(language);
  if (!queries) return null;

  let tree: TSTree | null;
  try {
    tree = parserEntry.parser.parse(content);
  } catch {
    return null;
  }
  if (!tree) return null;

  const rootNode = tree.rootNode;
  const lang = parserEntry.lang;

  // --- Entities ---
  const entityMatches = runQueryWithFallback(lang, queries.entities, rootNode);
  const entities: TreeSitterEntity[] = [];
  const seenEntityKeys = new Set<string>();

  for (const match of entityMatches) {
    const nameCapture = match.captures.find((c) => c.name === 'name');
    const entityCapture = match.captures.find((c) => c.name === 'entity');
    if (!nameCapture || !entityCapture) continue;

    const entityNode = entityCapture.node;
    // `const x = require('…')` belongs to the CommonJS import block, not the definitions.
    const value = entityNode.type === 'variable_declarator' ? entityNode.childForFieldName('value') : null;
    if (value?.type === 'call_expression' && value.childForFieldName('function')?.text === 'require') continue;
    const name = nameCapture.node.text;
    let type = detectEntityType(entityNode, language);
    // Python `def` in a class, Rust `fn` in an impl: methods of that type.
    if (type === 'function' && enclosingClassName(entityNode)) type = 'method';
    const startLine = entityNode.startPosition.row;
    const endLine = entityNode.endPosition.row;

    // Deduplicate: same name + same start line means a duplicate match
    // (e.g., both the bare function and the export_statement match)
    const key = `${name}:${startLine}`;
    if (seenEntityKeys.has(key)) {
      // If the existing entity is not marked exported but this match has
      // an @export capture, update the existing entity
      const existing = entities.find((e) => e.name === name && e.startLine === startLine);
      const hasExportCapture = match.captures.some((c) => c.name === 'export');
      if (existing && hasExportCapture) {
        existing.isExported = true;
      }
      continue;
    }
    seenEntityKeys.add(key);

    const hasExportCapture = match.captures.some((c) => c.name === 'export');
    const exported = hasExportCapture || isExported(entityNode, language, content);
    const parentName = type === 'method' ? findContainingEntity(entityNode) : undefined;
    const signature = extractSignature(entityNode, type, content);
    const body = content.slice(entityNode.startIndex, entityNode.endIndex);

    entities.push({
      name,
      type,
      startLine,
      endLine,
      startByte: entityNode.startIndex,
      endByte: entityNode.endIndex,
      parent: parentName,
      signature,
      isExported: exported,
      local: isLocal(entityNode),
      body,
    });
  }

  // --- Imports ---
  const importMatches = runQueryWithFallback(lang, queries.imports, rootNode);
  const imports = parseImportMatches(importMatches, language, content, rootNode);

  // --- Call sites ---
  const callMatches = runQueryWithFallback(lang, queries.calls, rootNode);
  const callSites = parseCallMatches(callMatches, entities);

  // --- Type references ---
  const typeRefMatches = runQueryWithFallback(lang, queries.typeRefs, rootNode);
  const typeReferences = parseTypeRefMatches(typeRefMatches, entities);

  tree.delete();

  return {
    filePath,
    language,
    entities,
    imports,
    callSites,
    typeReferences,
  };
}

// ---------------------------------------------------------------------------
// Batch parse
// ---------------------------------------------------------------------------

/**
 * Parse multiple files, initializing Tree-sitter once.
 * Returns results for all files that parsed successfully (failures are skipped).
 */
export async function parseFiles(
  files: Array<{ path: string; content: string; language: string }>,
): Promise<FileParseResult[]> {
  await initTreeSitter();

  const results: FileParseResult[] = [];

  for (const file of files) {
    const result = await parseFile(file.path, file.content, file.language);
    if (result) results.push(result);
  }

  return results;
}

// ---------------------------------------------------------------------------
// Structural hash (WS-6 foundation)
// ---------------------------------------------------------------------------

/**
 * Compute a structural hash of an entity's AST subtree.
 *
 * Two functions with identical logic but different variable names produce the
 * same hash. This is used by WS-6 for deduplication.
 *
 * The algorithm:
 * 1. Parse the entity body into an AST
 * 2. Walk the tree, collecting node types (skip comments and whitespace)
 * 3. Normalize identifier names to positional tokens (v0, v1, v2...)
 * 4. Build a canonical string representation
 * 5. SHA256 hash it
 */
export async function computeStructuralHash(
  _content: string,
  entity: TreeSitterEntity,
  language: string,
): Promise<string | null> {
  await initTreeSitter();

  const parserEntry = await getParserAndLang(language);
  if (!parserEntry) return null;

  let tree: TSTree | null;
  try {
    tree = parserEntry.parser.parse(entity.body);
  } catch {
    return null;
  }
  if (!tree) return null;

  const identifierMap = new Map<string, string>();
  let identifierCounter = 0;
  const tokens: string[] = [];

  const SKIP_TYPES = new Set([
    'comment', 'line_comment', 'block_comment', 'doc_comment',
    // Whitespace nodes are typically not named, but include for safety
  ]);

  const IDENTIFIER_TYPES = new Set([
    'identifier', 'type_identifier', 'property_identifier',
    'field_identifier', 'shorthand_field_identifier',
    'name', 'dotted_name',
  ]);

  function walk(node: TSNode): void {
    // Skip comments
    if (SKIP_TYPES.has(node.type)) return;

    if (node.namedChildCount === 0) {
      // Leaf node
      if (IDENTIFIER_TYPES.has(node.type)) {
        // Normalize identifiers to positional tokens
        const text = node.text;
        if (!identifierMap.has(text)) {
          identifierMap.set(text, `v${identifierCounter++}`);
        }
        tokens.push(`${node.type}:${identifierMap.get(text)}`);
      } else {
        // Literals, keywords, operators — keep node type + text
        tokens.push(`${node.type}:${node.text}`);
      }
    } else {
      // Internal node — record structure
      tokens.push(`(${node.type}`);
      for (const child of node.namedChildren) {
        walk(child);
      }
      tokens.push(')');
    }
  }

  walk(tree.rootNode);
  tree.delete();

  const canonical = tokens.join(' ');
  return createHash('sha256').update(canonical).digest('hex');
}

// ---------------------------------------------------------------------------
// Supported languages query
// ---------------------------------------------------------------------------

/** Returns the list of languages supported by the Tree-sitter parser. */
export function supportedLanguages(): string[] {
  return Object.keys(GRAMMAR_MAP);
}
