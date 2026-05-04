/**
 * Contract Guard Phase 2 — impact analyzer.
 *
 * Given a `ContractDiff` (from Phase 1) and a `ContractGraph` (from Phase 2
 * graph-builder), attribute each breaking change to the set of consumer call
 * sites it will affect. Walks type references transitively so that a change
 * to `User.email` surfaces at any endpoint whose request/response transitively
 * contains a `User`.
 */

import type {
  Contract,
  ContractChange,
  ContractDiff,
  ContractEndpoint,
  ContractType,
} from './contract-types.js';
import type { ConsumerCall } from './contract-consumer-detector.js';
import type { ContractGraph } from './contract-graph-builder.js';

export interface ImpactReport {
  diff: ContractDiff;
  breakingChanges: ContractChange[];
  affectedCallsByChange: Array<{
    change: ContractChange;
    calls: ConsumerCall[];
  }>;
  affectedConsumerRepos: string[];
  totalBreakingCallSites: number;
}

/* ── Helpers ─────────────────────────────────────────────────────────────── */

/** Get the endpoint-id part of a change path if the path starts with one. */
function endpointIdFromPath(path: string): string | null {
  // Endpoint ids look like `GET /users` or `svc.pkg.Service/Method` and we
  // recorded paths like `GET /users.response.email` or `svc/Method.request.x`.
  // The suffix begins with `.response` or `.request`.
  const idx = path.search(/\.(request|response)\b/);
  if (idx === -1) return null;
  return path.slice(0, idx);
}

/** Get the leading type name if the path is `TypeName.field.subfield...`. */
function typeNameFromPath(path: string): string | null {
  const dot = path.indexOf('.');
  if (dot === -1) return null;
  const head = path.slice(0, dot);
  // Reject endpoint-looking heads (contain space or slash).
  if (/[\s/]/.test(head)) return null;
  return head;
}

/**
 * Compute the set of type names that transitively reference `rootType`
 * (including `rootType` itself) within `contract.types`.
 */
function typesReferencing(contract: Contract, rootType: string): Set<string> {
  // Build reverse edges: typeB depends on typeA if typeB.field.type includes typeA.
  const reverse = new Map<string, Set<string>>();
  const typeNames = new Set(Object.keys(contract.types));
  for (const t of Object.values(contract.types)) {
    for (const f of t.fields) {
      for (const ref of extractTypeRefs(f.type)) {
        if (!typeNames.has(ref)) continue;
        let s = reverse.get(ref);
        if (!s) {
          s = new Set();
          reverse.set(ref, s);
        }
        s.add(t.name);
      }
    }
  }

  const out = new Set<string>();
  const stack = [rootType];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (out.has(next)) continue;
    out.add(next);
    const parents = reverse.get(next);
    if (parents) for (const p of parents) stack.push(p);
  }
  return out;
}

function extractTypeRefs(normalized: string): string[] {
  // Normalized types look like `User`, `array<User>`, `string|null`, `map<string,User>`.
  const out: string[] = [];
  const re = /[A-Za-z_][A-Za-z0-9_]*/g;
  let m: RegExpExecArray | null;
  const prims = new Set([
    'string', 'number', 'integer', 'int', 'int32', 'int64', 'uint32', 'uint64',
    'float', 'double', 'bool', 'boolean', 'null', 'bytes', 'any', 'void',
    'array', 'map', 'object', 'list',
  ]);
  while ((m = re.exec(normalized)) !== null) {
    if (!prims.has(m[0].toLowerCase())) out.push(m[0]);
  }
  return out;
}

/**
 * Collect endpoint ids whose request or response type (transitively) contains
 * any of the given type names.
 */
function endpointsUsingTypes(contract: Contract, types: Set<string>): string[] {
  if (types.size === 0) return [];

  // For each declared type, remember which root types reference it so we can
  // cheaply check each endpoint. We actually do the opposite: for every target
  // type `t` expand the closure of types that reference `t`, then intersect
  // with each endpoint's req/res closure.

  const closureOfType = new Map<string, Set<string>>();
  for (const t of types) {
    closureOfType.set(t, typesReferencing(contract, t));
  }

  const hitEndpoints: string[] = [];
  for (const ep of contract.endpoints) {
    const roots: string[] = [];
    if (ep.requestType) roots.push(ep.requestType);
    if (ep.responseType) roots.push(ep.responseType);
    if (roots.length === 0) continue;

    // Build the transitive closure of types reachable FROM the endpoint.
    const reachable = typesReachableFrom(contract, roots);
    let hit = false;
    for (const target of types) {
      if (reachable.has(target)) {
        hit = true;
        break;
      }
    }
    if (hit) hitEndpoints.push(ep.id);
  }
  return hitEndpoints;
}

function typesReachableFrom(contract: Contract, roots: string[]): Set<string> {
  const out = new Set<string>();
  const stack = [...roots];
  while (stack.length > 0) {
    const next = stack.pop() as string;
    if (out.has(next)) continue;
    out.add(next);
    const t: ContractType | undefined = contract.types[next];
    if (!t) continue;
    for (const f of t.fields) {
      for (const ref of extractTypeRefs(f.type)) {
        if (contract.types[ref] && !out.has(ref)) stack.push(ref);
      }
    }
  }
  return out;
}

function endpointByPath(contract: Contract, path: string): ContractEndpoint | undefined {
  // Paths like `GET /users` — search by verbose id.
  return contract.endpoints.find((e) => e.id === path);
}

/* ── Public API ──────────────────────────────────────────────────────────── */

export function analyzeContractImpact(
  diff: ContractDiff,
  graph: ContractGraph,
): ImpactReport {
  const breakingChanges = diff.changes.filter((c) => c.severity === 'breaking');

  // Use the `before` contract for change attribution — that's what consumers
  // were written against.
  const contract = diff.before;

  // Build a fast lookup from endpointId → edges for this producer.
  const edgesByEndpoint = new Map<string, ConsumerCall[]>();
  for (const edge of graph.edges) {
    if (edge.contractRepo !== contract.repoName) continue;
    if (edge.contractName !== contract.name) continue;
    const call = graph.calls.find(
      (c) =>
        c.repoName === edge.consumerRepo &&
        c.filePath === edge.consumerFile &&
        c.lineNumber === edge.consumerLine &&
        c.matchedEndpointId === edge.endpointId,
    );
    if (!call) continue;
    let arr = edgesByEndpoint.get(edge.endpointId);
    if (!arr) {
      arr = [];
      edgesByEndpoint.set(edge.endpointId, arr);
    }
    arr.push(call);
  }

  const affectedCallsByChange: ImpactReport['affectedCallsByChange'] = [];
  const allAffected: ConsumerCall[] = [];

  for (const change of breakingChanges) {
    const endpointIds = new Set<string>();

    // 1. Direct endpoint reference: `endpointId.request.*` / `endpointId.response.*`.
    const fromPath = endpointIdFromPath(change.path);
    if (fromPath) endpointIds.add(fromPath);

    // 2. Direct endpoint removal: `change.path` IS the endpoint id.
    if (change.kind === 'endpoint-removed' || change.kind === 'endpoint-added') {
      const ep = endpointByPath(contract, change.path);
      if (ep) endpointIds.add(ep.id);
      else endpointIds.add(change.path);
    }

    // 3. Type-level change: walk the graph for every endpoint that transitively
    //    references the changed type.
    const typeName = typeNameFromPath(change.path);
    if (typeName && contract.types[typeName]) {
      for (const id of endpointsUsingTypes(contract, new Set([typeName]))) {
        endpointIds.add(id);
      }
    }

    const calls: ConsumerCall[] = [];
    for (const id of endpointIds) {
      const hits = edgesByEndpoint.get(id);
      if (!hits) continue;
      for (const h of hits) {
        calls.push(h);
        allAffected.push(h);
      }
    }

    affectedCallsByChange.push({ change, calls });
  }

  // Dedupe affected repos.
  const repos = new Set<string>();
  for (const c of allAffected) repos.add(c.repoName);
  const affectedConsumerRepos = Array.from(repos).sort();

  // Dedupe call sites for the global count.
  const siteKeys = new Set<string>();
  for (const c of allAffected) {
    siteKeys.add(`${c.repoName}|${c.filePath}|${c.lineNumber}`);
  }

  return {
    diff,
    breakingChanges,
    affectedCallsByChange,
    affectedConsumerRepos,
    totalBreakingCallSites: siteKeys.size,
  };
}
