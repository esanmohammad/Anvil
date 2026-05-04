/**
 * Hand-rolled parsers that normalize OpenAPI / proto / GraphQL / JSON Schema /
 * Avro source text into the shared `Contract` shape. No third-party deps.
 */

import { basename } from 'node:path';
import type {
  Contract,
  ContractEndpoint,
  ContractField,
  ContractKind,
  ContractType,
} from './contract-types.js';
import { parseYaml, type YamlValue } from './pipeline-policy.js';

// ── Small type guards over the YAML/JSON tree ───────────────────────────

function isObj(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function isArr(v: unknown): v is unknown[] {
  return Array.isArray(v);
}
function isStr(v: unknown): v is string {
  return typeof v === 'string';
}

// ── Unified entrypoint ──────────────────────────────────────────────────

export function parseContract(
  kind: ContractKind,
  text: string,
  sourceFile: string,
  repoName: string,
): Contract | null {
  switch (kind) {
    case 'openapi':
      return parseOpenapi(text, sourceFile, repoName);
    case 'protobuf':
      return parseProto(text, sourceFile, repoName);
    case 'graphql':
      return parseGraphql(text, sourceFile, repoName);
    case 'jsonschema':
      return parseJsonSchema(text, sourceFile, repoName);
    case 'avro':
      return parseAvro(text, sourceFile, repoName);
    default:
      return null;
  }
}

// ── OpenAPI / Swagger ───────────────────────────────────────────────────

export function parseOpenapi(
  sourceText: string,
  sourceFile: string,
  repoName: string,
): Contract | null {
  const root = parseYamlOrJson(sourceText);
  if (!isObj(root)) return null;

  const info = isObj(root.info) ? root.info : {};
  const name = isStr(info.title) ? info.title : basename(sourceFile);
  const version = isStr(info.version) ? info.version : undefined;

  const types: Record<string, ContractType> = {};
  const components = isObj(root.components) ? root.components : {};
  const schemas = isObj(components.schemas) ? components.schemas : {};
  for (const [typeName, schema] of Object.entries(schemas)) {
    if (!isObj(schema)) continue;
    types[typeName] = openapiSchemaToType(typeName, schema);
  }

  const endpoints: ContractEndpoint[] = [];
  const paths = isObj(root.paths) ? root.paths : {};
  const verbs = ['get', 'post', 'put', 'patch', 'delete', 'options', 'head'];
  for (const [path, item] of Object.entries(paths)) {
    if (!isObj(item)) continue;
    for (const verb of verbs) {
      const op = item[verb];
      if (!isObj(op)) continue;
      const id = `${verb.toUpperCase()} ${path}`;
      const requestType = openapiRequestTypeName(op);
      const responseType = openapiResponseTypeName(op);
      endpoints.push({
        id,
        method: verb.toUpperCase(),
        path,
        requestType,
        responseType,
      });
    }
  }

  return {
    kind: 'openapi',
    sourceFile,
    repoName,
    name,
    version,
    endpoints,
    types,
  };
}

function parseYamlOrJson(text: string): unknown {
  const trimmed = text.trimStart();
  const first = trimmed.charAt(0);
  if (first === '{' || first === '[') {
    try {
      return JSON.parse(text);
    } catch {
      return null;
    }
  }
  try {
    return parseYaml(text) as unknown;
  } catch {
    return null;
  }
}

function openapiRefName(ref: string): string | undefined {
  // Only handle `#/components/schemas/Foo` shallowly.
  const m = ref.match(/#\/components\/schemas\/([A-Za-z0-9_.-]+)$/);
  return m ? m[1] : undefined;
}

function openapiRequestTypeName(op: Record<string, unknown>): string | undefined {
  const body = isObj(op.requestBody) ? op.requestBody : undefined;
  if (!body) return undefined;
  const content = isObj(body.content) ? body.content : undefined;
  if (!content) return undefined;
  for (const media of Object.values(content)) {
    if (!isObj(media)) continue;
    const schema = isObj(media.schema) ? media.schema : undefined;
    if (!schema) continue;
    const refStr = isStr(schema.$ref) ? schema.$ref : undefined;
    if (refStr) return openapiRefName(refStr);
  }
  return undefined;
}

function openapiResponseTypeName(op: Record<string, unknown>): string | undefined {
  const responses = isObj(op.responses) ? op.responses : undefined;
  if (!responses) return undefined;
  // Prefer 200, then 201, then first 2xx, then any.
  const preferred = ['200', '201', '202', '204'];
  const keys = Object.keys(responses);
  const ordered = [
    ...preferred.filter((k) => keys.includes(k)),
    ...keys.filter((k) => !preferred.includes(k)),
  ];
  for (const k of ordered) {
    const r = responses[k];
    if (!isObj(r)) continue;
    const content = isObj(r.content) ? r.content : undefined;
    if (!content) continue;
    for (const media of Object.values(content)) {
      if (!isObj(media)) continue;
      const schema = isObj(media.schema) ? media.schema : undefined;
      if (!schema) continue;
      const refStr = isStr(schema.$ref) ? schema.$ref : undefined;
      if (refStr) return openapiRefName(refStr);
    }
  }
  return undefined;
}

function openapiTypeString(schema: Record<string, unknown>): string {
  const refStr = isStr(schema.$ref) ? schema.$ref : undefined;
  if (refStr) {
    const n = openapiRefName(refStr);
    if (n) return n;
  }
  const t = isStr(schema.type) ? schema.type : undefined;
  const nullable = schema.nullable === true;
  let base = t ?? 'unknown';
  if (base === 'array') {
    const items = isObj(schema.items) ? openapiTypeString(schema.items) : 'unknown';
    base = `array<${items}>`;
  }
  if (nullable) return `${base}|null`;
  return base;
}

function openapiSchemaToType(
  name: string,
  schema: Record<string, unknown>,
): ContractType {
  if (isArr(schema.enum)) {
    const enumValues = schema.enum.filter(isStr);
    return { name, kind: 'enum', fields: [], enumValues };
  }
  const kind = isStr(schema.type) ? schema.type : 'object';
  if (kind !== 'object') {
    return {
      name,
      kind: kind === 'array' ? 'array' : 'scalar',
      fields: [],
    };
  }
  const requiredSet = new Set<string>(
    isArr(schema.required) ? (schema.required.filter(isStr) as string[]) : [],
  );
  const props = isObj(schema.properties) ? schema.properties : {};
  const fields: ContractField[] = [];
  for (const [fieldName, propAny] of Object.entries(props)) {
    if (!isObj(propAny)) continue;
    const typeStr = openapiTypeString(propAny);
    const nullable = propAny.nullable === true;
    const field: ContractField = {
      name: fieldName,
      type: typeStr,
      required: requiredSet.has(fieldName),
      nullable,
    };
    if (isArr(propAny.enum)) {
      field.enumValues = propAny.enum.filter(isStr) as string[];
    }
    if (isStr(propAny.description)) field.description = propAny.description;
    fields.push(field);
  }
  const out: ContractType = { name, kind: 'object', fields };
  if (isStr(schema.description)) out.description = schema.description;
  return out;
}

// ── Protobuf (proto3-ish, regex-based) ──────────────────────────────────

export function parseProto(
  text: string,
  sourceFile: string,
  repoName: string,
): Contract {
  const stripped = stripProtoComments(text);
  const pkgMatch = stripped.match(/\bpackage\s+([A-Za-z0-9_.]+)\s*;/);
  const pkg = pkgMatch ? pkgMatch[1] : '';

  const types: Record<string, ContractType> = {};
  const endpoints: ContractEndpoint[] = [];

  // Messages: message Foo { ... }
  for (const m of matchAll(stripped, /\bmessage\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g)) {
    const typeName = m[1];
    const body = extractBraceBody(stripped, m.index! + m[0].length - 1);
    if (body === null) continue;
    const fields = parseProtoFields(body);
    types[typeName] = { name: typeName, kind: 'object', fields };
  }

  // Enums: enum Color { RED = 0; GREEN = 1; }
  for (const m of matchAll(stripped, /\benum\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g)) {
    const typeName = m[1];
    const body = extractBraceBody(stripped, m.index! + m[0].length - 1);
    if (body === null) continue;
    const enumValues: string[] = [];
    for (const e of matchAll(body, /\b([A-Z_][A-Z0-9_]*)\s*=\s*-?\d+\s*;/g)) {
      enumValues.push(e[1]);
    }
    types[typeName] = { name: typeName, kind: 'enum', fields: [], enumValues };
  }

  // Services + rpcs
  const serviceRegex = /\bservice\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g;
  let svcMatch: RegExpExecArray | null;
  while ((svcMatch = serviceRegex.exec(stripped)) !== null) {
    const serviceName = svcMatch[1];
    const body = extractBraceBody(stripped, svcMatch.index + svcMatch[0].length - 1);
    if (body === null) continue;
    const rpcRegex =
      /\brpc\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*(stream\s+)?([A-Za-z0-9_.]+)\s*\)\s+returns\s*\(\s*(stream\s+)?([A-Za-z0-9_.]+)\s*\)/g;
    for (const r of matchAll(body, rpcRegex)) {
      const rpcName = r[1];
      const reqStream = !!r[2];
      const reqType = r[3];
      const resStream = !!r[4];
      const resType = r[5];
      const id = pkg
        ? `${pkg}.${serviceName}/${rpcName}`
        : `${serviceName}/${rpcName}`;
      endpoints.push({
        id,
        requestType: reqType,
        responseType: resType,
        streaming: reqStream || resStream,
      });
    }
  }

  return {
    kind: 'protobuf',
    sourceFile,
    repoName,
    name: pkg || basename(sourceFile, '.proto'),
    endpoints,
    types,
  };
}

function stripProtoComments(text: string): string {
  // Remove /* ... */ and // ... comments.
  return text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
}

function extractBraceBody(text: string, openBraceIdx: number): string | null {
  if (text[openBraceIdx] !== '{') return null;
  let depth = 0;
  for (let i = openBraceIdx; i < text.length; i++) {
    const ch = text[i];
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return text.slice(openBraceIdx + 1, i);
    }
  }
  return null;
}

function parseProtoFields(body: string): ContractField[] {
  const fields: ContractField[] = [];
  // `repeated? type name = n;` (skip nested messages/enums, oneofs not deep-parsed)
  const fieldRegex =
    /(?:^|\n|;)\s*(repeated\s+|optional\s+|required\s+)?([A-Za-z_][A-Za-z0-9_.<>]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*\d+\s*(?:\[[^\]]*\])?\s*;/g;
  for (const m of matchAll(body, fieldRegex)) {
    const modifier = (m[1] || '').trim();
    const typeRaw = m[2];
    const fieldName = m[3];
    if (typeRaw === 'message' || typeRaw === 'enum' || typeRaw === 'oneof') continue;
    const isRepeated = modifier === 'repeated';
    const type = isRepeated ? `array<${typeRaw}>` : typeRaw;
    const required = modifier === 'required';
    fields.push({
      name: fieldName,
      type,
      required,
      nullable: false,
    });
  }
  return fields;
}

// ── GraphQL (regex-based) ───────────────────────────────────────────────

export function parseGraphql(
  text: string,
  sourceFile: string,
  repoName: string,
): Contract {
  const stripped = text
    .replace(/"""[\s\S]*?"""/g, '')
    .replace(/(^|[^:])#[^\n]*/g, '$1');

  const types: Record<string, ContractType> = {};

  for (const m of matchAll(
    stripped,
    /\b(type|input)\s+([A-Za-z_][A-Za-z0-9_]*)(?:\s+implements[^{]*)?\s*\{/g,
  )) {
    const typeName = m[2];
    const body = extractBraceBody(stripped, m.index! + m[0].length - 1);
    if (body === null) continue;
    const fields = parseGraphqlFields(body);
    types[typeName] = { name: typeName, kind: 'object', fields };
  }

  for (const m of matchAll(stripped, /\benum\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{/g)) {
    const typeName = m[1];
    const body = extractBraceBody(stripped, m.index! + m[0].length - 1);
    if (body === null) continue;
    const enumValues: string[] = [];
    for (const line of body.split('\n')) {
      const t = line.trim();
      if (!t) continue;
      const vm = t.match(/^([A-Z_][A-Z0-9_]*)\b/);
      if (vm) enumValues.push(vm[1]);
    }
    types[typeName] = { name: typeName, kind: 'enum', fields: [], enumValues };
  }

  // Endpoints: Query / Mutation / Subscription fields (flattened).
  const endpoints: ContractEndpoint[] = [];
  for (const rootName of ['Query', 'Mutation', 'Subscription']) {
    const t = types[rootName];
    if (!t) continue;
    for (const f of t.fields) {
      endpoints.push({
        id: `${rootName}.${f.name}`,
        responseType: stripGraphqlTypeMarkers(f.type).bareType,
        streaming: rootName === 'Subscription',
      });
    }
  }

  return {
    kind: 'graphql',
    sourceFile,
    repoName,
    name: basename(sourceFile),
    endpoints,
    types,
  };
}

function parseGraphqlFields(body: string): ContractField[] {
  const fields: ContractField[] = [];
  const lines = body.split('\n');
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) continue;
    // `name: Type!` or `name(arg: X): Type!`
    const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*(?:\([^)]*\))?\s*:\s*(.+?)\s*$/);
    if (!m) continue;
    const fieldName = m[1];
    let rawType = m[2].replace(/,\s*$/, '').trim();
    // drop trailing comments already stripped; drop directives
    rawType = rawType.replace(/@[A-Za-z_][A-Za-z0-9_]*(?:\([^)]*\))?/g, '').trim();
    const { bareType, required } = stripGraphqlTypeMarkers(rawType);
    fields.push({
      name: fieldName,
      type: bareType,
      required,
      nullable: !required,
    });
  }
  return fields;
}

function stripGraphqlTypeMarkers(raw: string): { bareType: string; required: boolean } {
  let s = raw.trim();
  const required = s.endsWith('!');
  if (required) s = s.slice(0, -1).trim();
  // `[Type!]!` → array<Type>
  const listMatch = s.match(/^\[(.+)\]$/);
  if (listMatch) {
    const inner = stripGraphqlTypeMarkers(listMatch[1]).bareType;
    return { bareType: `array<${inner}>`, required };
  }
  return { bareType: s, required };
}

// ── JSON Schema ─────────────────────────────────────────────────────────

export function parseJsonSchema(
  text: string,
  sourceFile: string,
  repoName: string,
): Contract | null {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(root)) return null;

  const types: Record<string, ContractType> = {};
  const rootName = isStr(root.title) ? root.title : basename(sourceFile, '.json');

  // Collect definitions (JSON Schema draft-07: `definitions`, draft-2019+: `$defs`).
  const defs: Record<string, Record<string, unknown>> = {};
  const definitions = isObj(root.definitions) ? root.definitions : {};
  const defsAlt = isObj(root.$defs) ? root.$defs : {};
  for (const [k, v] of Object.entries({ ...definitions, ...defsAlt })) {
    if (isObj(v)) defs[k] = v;
  }

  function resolveRef(ref: string): Record<string, unknown> | null {
    const m = ref.match(/#\/(?:definitions|\$defs)\/([A-Za-z0-9_.-]+)$/);
    if (!m) return null;
    const target = defs[m[1]];
    return target ?? null;
  }

  function typeStr(schema: Record<string, unknown>): string {
    if (isStr(schema.$ref)) {
      const m = schema.$ref.match(/#\/(?:definitions|\$defs)\/([A-Za-z0-9_.-]+)$/);
      if (m) return m[1];
    }
    const raw = schema.type;
    if (isArr(raw)) {
      const parts = raw.filter(isStr);
      return parts.join('|');
    }
    if (isStr(raw)) {
      if (raw === 'array') {
        const items = isObj(schema.items) ? typeStr(schema.items) : 'unknown';
        return `array<${items}>`;
      }
      return raw;
    }
    return 'unknown';
  }

  function toType(name: string, schema: Record<string, unknown>): ContractType {
    // Shallow $ref resolution (one level).
    if (isStr(schema.$ref)) {
      const resolved = resolveRef(schema.$ref);
      if (resolved) return toType(name, resolved);
    }
    if (isArr(schema.enum)) {
      const enumValues = schema.enum.filter(isStr);
      return { name, kind: 'enum', fields: [], enumValues };
    }
    const t = schema.type;
    const isObject = t === 'object' || (t === undefined && isObj(schema.properties));
    if (!isObject) {
      return {
        name,
        kind: t === 'array' ? 'array' : 'scalar',
        fields: [],
      };
    }
    const requiredSet = new Set<string>(
      isArr(schema.required) ? (schema.required.filter(isStr) as string[]) : [],
    );
    const props = isObj(schema.properties) ? schema.properties : {};
    const fields: ContractField[] = [];
    for (const [fieldName, propAny] of Object.entries(props)) {
      if (!isObj(propAny)) continue;
      const ts = typeStr(propAny);
      const nullable = ts.split('|').includes('null');
      const field: ContractField = {
        name: fieldName,
        type: ts,
        required: requiredSet.has(fieldName),
        nullable,
      };
      if (isArr(propAny.enum)) field.enumValues = propAny.enum.filter(isStr) as string[];
      if (isStr(propAny.description)) field.description = propAny.description;
      fields.push(field);
    }
    const out: ContractType = { name, kind: 'object', fields };
    if (isStr(schema.description)) out.description = schema.description;
    return out;
  }

  // Add the root, if it looks like an object schema.
  const rootType = toType(rootName, root);
  types[rootName] = rootType;
  for (const [name, schema] of Object.entries(defs)) {
    types[name] = toType(name, schema);
  }

  return {
    kind: 'jsonschema',
    sourceFile,
    repoName,
    name: rootName,
    endpoints: [],
    types,
  };
}

// ── Avro (stub — just pulls name + top-level fields) ────────────────────

export function parseAvro(
  text: string,
  sourceFile: string,
  repoName: string,
): Contract | null {
  let root: unknown;
  try {
    root = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isObj(root)) return null;
  const name = isStr(root.name) ? root.name : basename(sourceFile, '.avsc');

  const types: Record<string, ContractType> = {};
  const fields: ContractField[] = [];
  if (isArr(root.fields)) {
    for (const f of root.fields) {
      if (!isObj(f)) continue;
      const fieldName = isStr(f.name) ? f.name : undefined;
      if (!fieldName) continue;
      const rawType = f.type;
      let typeString = 'unknown';
      let nullable = false;
      if (isStr(rawType)) {
        typeString = rawType;
      } else if (isArr(rawType)) {
        const parts = rawType.map((t) => (isStr(t) ? t : isObj(t) && isStr(t.type) ? t.type : 'unknown'));
        nullable = parts.includes('null');
        typeString = parts.join('|');
      } else if (isObj(rawType) && isStr(rawType.type)) {
        typeString = rawType.type;
      }
      const hasDefault = 'default' in f;
      fields.push({
        name: fieldName,
        type: typeString,
        required: !hasDefault && !nullable,
        nullable,
      });
    }
  }
  types[name] = { name, kind: 'object', fields };

  return {
    kind: 'avro',
    sourceFile,
    repoName,
    name,
    endpoints: [],
    types,
  };
}

// ── Utility ─────────────────────────────────────────────────────────────

function matchAll(text: string, regex: RegExp): RegExpExecArray[] {
  const out: RegExpExecArray[] = [];
  const re = new RegExp(regex.source, regex.flags.includes('g') ? regex.flags : regex.flags + 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.push(m);
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return out;
}

// Re-export YamlValue so consumers who only import this module have access.
export type { YamlValue };
