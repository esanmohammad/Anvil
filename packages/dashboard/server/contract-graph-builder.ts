/**
 * Contract Guard Phase 2 — graph builder.
 *
 * Joins Phase 1 `Contract`s with detected `ConsumerCall`s by resolving each
 * call's URL/path against the producer's declared endpoints. Handles trailing
 * slashes, query strings, and path parameters (`/users/123` vs `/users/:id`).
 */

import type { Contract, ContractEndpoint } from './contract-types.js';
import type { ConsumerCall } from './contract-consumer-detector.js';

export interface ContractConsumerEdge {
  contractRepo: string;
  contractName: string;
  endpointId: string;
  consumerRepo: string;
  consumerFile: string;
  consumerLine: number;
}

export interface ContractGraph {
  contracts: Contract[];
  calls: ConsumerCall[];
  edges: ContractConsumerEdge[];
  orphans: ConsumerCall[];
}

/* ── Path normalization ──────────────────────────────────────────────────── */

/**
 * Strip scheme/host, query, fragment; normalise trailing slashes; keep a
 * leading slash on the path component.
 */
function normalisePath(raw: string): string {
  if (!raw) return '';
  let p = raw.trim();

  // Template strings: drop any ${expr} segments so `/users/${id}` → `/users/:param`.
  p = p.replace(/\$\{[^}]*\}/g, ':param');

  // Strip scheme + host.
  const schemeMatch = /^[a-z][a-z0-9+\-.]*:\/\/[^/]+(.*)$/i.exec(p);
  if (schemeMatch) p = schemeMatch[1] || '/';

  // Drop query + fragment.
  const q = p.indexOf('?');
  if (q !== -1) p = p.slice(0, q);
  const h = p.indexOf('#');
  if (h !== -1) p = p.slice(0, h);

  if (!p.startsWith('/')) p = `/${p}`;

  // Collapse double slashes and drop trailing slash (except root).
  p = p.replace(/\/+/g, '/');
  if (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);

  return p;
}

/** Convert an endpoint path template into a matcher. */
function templateToRegex(template: string): RegExp {
  const norm = normalisePath(template);
  // Support both `:id` and `{id}` styles.
  const pattern = norm
    .replace(/[.+^$()|[\]\\]/g, '\\$&')
    .replace(/\{[^/}]+\}/g, '[^/]+')
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, '[^/]+');
  return new RegExp(`^${pattern}$`);
}

function segmentCount(path: string): number {
  return normalisePath(path).split('/').filter(Boolean).length;
}

/** Looks like a literal path segment with no template placeholder. */
function isConcrete(seg: string): boolean {
  return !/^[:{]/.test(seg) && !seg.endsWith('}');
}

/**
 * Score a candidate endpoint vs. a call path. Higher is better; -1 means
 * structurally incompatible.
 */
function scoreMatch(endpointPath: string, callPath: string): number {
  const ep = normalisePath(endpointPath).split('/').filter(Boolean);
  const cp = callPath.split('/').filter(Boolean);
  if (ep.length !== cp.length) return -1;

  let score = 0;
  for (let i = 0; i < ep.length; i++) {
    const es = ep[i];
    const cs = cp[i];
    const epIsParam = !isConcrete(es);
    if (!epIsParam) {
      if (es !== cs) return -1;
      score += 2; // concrete match
    } else {
      score += 1; // param binding
    }
  }
  return score;
}

function methodMatches(endpoint: ContractEndpoint, call: ConsumerCall): boolean {
  // Not all endpoints (e.g. gRPC) have HTTP verbs — treat absence as wildcard.
  if (!endpoint.method) return true;
  if (!call.method) return false;
  return endpoint.method.toUpperCase() === call.method.toUpperCase();
}

/* ── gRPC match ──────────────────────────────────────────────────────────── */

function matchGrpc(contract: Contract, call: ConsumerCall): ContractEndpoint | null {
  if (!call.method) return null;
  for (const ep of contract.endpoints) {
    if (!ep.id) continue;
    // Proto endpoint ids look like `user.v1.UserService/GetUser`.
    const slash = ep.id.lastIndexOf('/');
    const epMethod = slash !== -1 ? ep.id.slice(slash + 1) : ep.id;
    if (epMethod === call.method) return ep;
  }
  return null;
}

/* ── HTTP match ──────────────────────────────────────────────────────────── */

function matchHttp(contracts: Contract[], call: ConsumerCall): {
  contract: Contract;
  endpoint: ContractEndpoint;
} | null {
  const callPath = normalisePath(call.urlOrPath ?? '');
  if (!callPath) return null;

  let best: { score: number; contract: Contract; endpoint: ContractEndpoint } | null = null;

  for (const contract of contracts) {
    for (const ep of contract.endpoints) {
      if (!ep.path) continue;
      if (!methodMatches(ep, call)) continue;
      if (segmentCount(ep.path) !== callPath.split('/').filter(Boolean).length) continue;
      const score = scoreMatch(ep.path, callPath);
      if (score < 0) continue;
      if (!best || score > best.score) {
        best = { score, contract, endpoint: ep };
      }
    }
  }

  // Fallback: regex template match even if segment counts align via wildcards.
  if (!best) {
    for (const contract of contracts) {
      for (const ep of contract.endpoints) {
        if (!ep.path) continue;
        if (!methodMatches(ep, call)) continue;
        if (templateToRegex(ep.path).test(callPath)) {
          const score = 0;
          if (!best || score > best.score) {
            best = { score, contract, endpoint: ep };
          }
        }
      }
    }
  }

  return best ? { contract: best.contract, endpoint: best.endpoint } : null;
}

/* ── Public API ──────────────────────────────────────────────────────────── */

export function buildContractGraph(
  contracts: Contract[],
  calls: ConsumerCall[],
): ContractGraph {
  const edges: ContractConsumerEdge[] = [];
  const orphans: ConsumerCall[] = [];
  const seen = new Set<string>();
  const annotated: ConsumerCall[] = [];

  for (const raw of calls) {
    let matched: { contract: Contract; endpoint: ContractEndpoint } | null = null;

    if (raw.kind === 'grpc') {
      for (const c of contracts) {
        const ep = matchGrpc(c, raw);
        if (ep) {
          matched = { contract: c, endpoint: ep };
          break;
        }
      }
    } else if (raw.kind === 'http') {
      matched = matchHttp(contracts, raw);
    } else if (raw.kind === 'graphql') {
      // Best-effort: match if any endpoint.id contains the operation name.
      const needle = raw.method ?? raw.urlOrPath;
      if (needle) {
        for (const c of contracts) {
          for (const ep of c.endpoints) {
            if (ep.id === needle || ep.path === needle) {
              matched = { contract: c, endpoint: ep };
              break;
            }
          }
          if (matched) break;
        }
      }
    }

    const call: ConsumerCall = matched
      ? { ...raw, matchedEndpointId: matched.endpoint.id }
      : { ...raw };
    annotated.push(call);

    if (!matched) {
      orphans.push(call);
      continue;
    }

    const key = [
      matched.contract.repoName,
      matched.contract.name,
      matched.endpoint.id,
      call.repoName,
      call.filePath,
      call.lineNumber,
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);

    edges.push({
      contractRepo: matched.contract.repoName,
      contractName: matched.contract.name,
      endpointId: matched.endpoint.id,
      consumerRepo: call.repoName,
      consumerFile: call.filePath,
      consumerLine: call.lineNumber,
    });
  }

  return { contracts, calls: annotated, edges, orphans };
}
