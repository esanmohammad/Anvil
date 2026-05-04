/**
 * Shared types for Contract Guard: a language-agnostic representation of API
 * contracts (OpenAPI / proto / GraphQL / JSON Schema / Avro) plus the diff model.
 */

export type ContractKind = 'openapi' | 'protobuf' | 'graphql' | 'jsonschema' | 'avro';

export interface ContractField {
  name: string;
  /** Normalized type string, e.g. `string`, `int32`, `string|null`, `User`, `array<string>`. */
  type: string;
  required: boolean;
  nullable: boolean;
  enumValues?: string[];
  description?: string;
}

export interface ContractType {
  name: string;
  kind: 'object' | 'enum' | 'scalar' | 'union' | 'array' | 'map';
  /** Empty for non-object kinds. */
  fields: ContractField[];
  enumValues?: string[];
  description?: string;
}

export interface ContractEndpoint {
  /** Stable id: `GET /api/users` for HTTP, `user.v1.UserService/GetUser` for RPC. */
  id: string;
  /** HTTP verb for openapi. */
  method?: string;
  /** HTTP path for openapi. */
  path?: string;
  /** References ContractType.name. */
  requestType?: string;
  responseType?: string;
  streaming?: boolean;
}

export interface Contract {
  kind: ContractKind;
  /** Repo-relative path to the source file. */
  sourceFile: string;
  repoName: string;
  /** Service / API name, or file basename if no explicit name was found. */
  name: string;
  version?: string;
  endpoints: ContractEndpoint[];
  types: Record<string, ContractType>;
}

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

export interface ContractChange {
  kind: ContractChangeKind;
  severity: 'breaking' | 'non-breaking' | 'needs-review';
  /** Dotted path, e.g. `User.email` or `GET /api/users.response.email`. */
  path: string;
  before?: string;
  after?: string;
  description: string;
}

export interface ContractDiff {
  before: Contract;
  after: Contract;
  changes: ContractChange[];
  breakingCount: number;
}
