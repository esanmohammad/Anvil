/**
 * Browser-safe mirrors of Contract Guard server types.
 *
 * Phase 4 lives in the UI bundle, so we cannot import from
 * `server/contract-types.ts` (it pulls `node:fs` via its discovery/parse
 * siblings). Keep these definitions field-compatible with Phase 1/2/3 so the
 * server-side `Contract`, `ContractChange`, and `ImpactReport` payloads drop
 * straight into these shapes at the WS boundary.
 */

export type ContractKind =
  | 'openapi'
  | 'protobuf'
  | 'graphql'
  | 'jsonschema'
  | 'avro';

export type ContractChangeKind =
  | 'field-removed'
  | 'field-added'
  | 'required-added'
  | 'required-removed'
  | 'type-narrowed'
  | 'type-widened'
  | 'enum-shrunk'
  | 'enum-extended'
  | 'endpoint-removed'
  | 'endpoint-added'
  | 'response-shape-changed'
  | 'request-shape-changed';

export type ContractChangeSeverity = 'breaking' | 'non-breaking' | 'needs-review';

export interface ContractChange {
  kind: ContractChangeKind;
  severity: ContractChangeSeverity;
  /** Dotted path, e.g. `User.email` or `GET /api/users.response.email`. */
  path: string;
  before?: string;
  after?: string;
  description: string;
}

/**
 * Narrow summary used by the left-pane list. The full `Contract` type carries
 * endpoint + type maps which the map page never renders; trimming the payload
 * keeps WS traffic light and avoids duplicating parser shapes in the UI.
 */
export interface ContractSummary {
  name: string;
  kind: ContractKind;
  repoName: string;
  sourceFile: string;
  version?: string;
  endpointCount: number;
}

export interface ContractConsumerCall {
  repoName: string;
  filePath: string;
  lineNumber: number;
  /** Short snippet of the matched call-site (single line, trimmed). */
  snippet: string;
  /** Optional endpoint id the call resolves to — enables the map's right pane. */
  endpointId?: string;
}

export interface ConsumerMapEntry {
  endpointId: string;
  method?: string;
  path?: string;
  calls: ContractConsumerCall[];
}

export interface ImpactReportChangeGroup {
  change: ContractChange;
  calls: ContractConsumerCall[];
}

export interface ImpactReport {
  breakingChanges: ContractChange[];
  affectedCallsByChange: ImpactReportChangeGroup[];
  affectedConsumerRepos: string[];
  totalBreakingCallSites: number;
}
