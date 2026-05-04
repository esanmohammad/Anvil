/**
 * Walks a repo looking for contract files (OpenAPI, proto, GraphQL, JSON Schema,
 * Avro), reads them, and hands each to the right parser.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative } from 'node:path';
import type { Contract, ContractKind } from './contract-types.js';
import { parseContract } from './contract-parser.js';

const MAX_DEPTH = 6;
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  'vendor',
  'out',
  '.cache',
  'coverage',
]);

interface Candidate {
  absPath: string;
  relPath: string;
  kind: ContractKind;
}

function classify(fileName: string, relPath: string): ContractKind | null {
  const lower = fileName.toLowerCase();
  const ext = extname(lower);

  // Proto
  if (ext === '.proto') return 'protobuf';

  // Avro
  if (ext === '.avsc') return 'avro';

  // GraphQL
  if (ext === '.graphql' || ext === '.gql') return 'graphql';

  // OpenAPI / Swagger
  const yamlish = ext === '.yaml' || ext === '.yml' || ext === '.json';
  if (yamlish) {
    const bare = lower.replace(/\.(ya?ml|json)$/, '');
    if (bare === 'openapi' || bare === 'swagger') return 'openapi';
  }

  // JSON Schema
  if (ext === '.json') {
    if (lower === 'schema.json' || lower.endsWith('.schema.json')) return 'jsonschema';
  }

  return null;
}

function walk(
  root: string,
  current: string,
  depth: number,
  out: Candidate[],
): void {
  if (depth > MAX_DEPTH) return;
  let entries: string[];
  try {
    entries = readdirSync(current);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    if (entry.startsWith('.') && entry !== '.' && entry !== '..') {
      // Skip other hidden dirs/files (e.g. .next, .turbo). Still allow explicit
      // contract files that happen to be hidden? Err on side of skipping.
      continue;
    }
    const abs = join(current, entry);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      walk(root, abs, depth + 1, out);
      continue;
    }
    if (!st.isFile()) continue;
    if (st.size > MAX_FILE_SIZE) continue;

    const rel = relative(root, abs);
    const kind = classify(entry, rel);
    if (!kind) continue;
    out.push({ absPath: abs, relPath: rel, kind });
  }
}

export function discoverContracts(repoLocalPath: string, repoName: string): Contract[] {
  let rootStat;
  try {
    rootStat = statSync(repoLocalPath);
  } catch {
    return [];
  }
  if (!rootStat.isDirectory()) return [];

  const candidates: Candidate[] = [];
  walk(repoLocalPath, repoLocalPath, 0, candidates);

  const results: Contract[] = [];
  for (const cand of candidates) {
    let text: string;
    try {
      text = readFileSync(cand.absPath, 'utf-8');
    } catch {
      continue;
    }
    // Cheap second-pass validation for `*.json` schema-ish files — if it
    // doesn't look like a JSON Schema we just skip it.
    if (cand.kind === 'jsonschema' && !looksLikeJsonSchema(text)) continue;

    try {
      const contract = parseContract(cand.kind, text, cand.relPath, repoName);
      if (contract) results.push(contract);
    } catch {
      // Parser failures are non-fatal — skip the file.
      continue;
    }
  }
  return results;
}

function looksLikeJsonSchema(text: string): boolean {
  // Keep this intentionally loose: the parser will do the real work.
  const head = text.slice(0, 2048);
  if (!/[{[]/.test(head)) return false;
  return (
    /"\$schema"\s*:/.test(head) ||
    /"properties"\s*:/.test(head) ||
    /"type"\s*:\s*"(?:object|array|string|number|integer|boolean|null)"/.test(head)
  );
}
