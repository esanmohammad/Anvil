export interface GlossaryEntry {
  term: string;
  definition: string;
}

export interface Invariant {
  id: string;
  statement: string;
  rationale?: string;
  criticality?: string;
}

export interface SharpEdge {
  id: string;
  statement: string;
  impacted_components?: string[];
  severity?: string;
}

export interface FlowStep {
  component: string;
  action: string;
  interface?: string;
  notes?: string;
  conditions?: string;
  failure_path?: string;
}

export interface CriticalFlow {
  id: string;
  name: string;
  trigger?: string;
  steps?: FlowStep[];
}

export interface HTTPInterface {
  name: string;
  method?: string;
  path?: string;
  purpose?: string;
  contract_ref?: string;
  auth?: string;
  stability?: string;
  owner?: string;
}

export interface KafkaInterface {
  topic: string;
  consumer_group?: string;
  purpose?: string;
  contract_ref?: string;
  schema_ref?: string;
  examples_ref?: string[];
  owner?: string;
  compatibility?: string;
  criticality?: string;
  key_format?: string;
  ordering_notes?: string;
  retry_notes?: string;
  dlq_topic?: string;
}

export interface RedisPubSubInterface {
  name: string;
  channel_pattern?: string;
  purpose?: string;
}

export interface RedisListInterface {
  name: string;
  key_pattern?: string;
  purpose?: string;
}

export interface MongoInterface {
  collection: string;
  purpose?: string;
}

export interface InterfaceGroup {
  http?: HTTPInterface[];
  kafka?: KafkaInterface[];
  redis_pubsub?: RedisPubSubInterface[];
  redis_lists?: RedisListInterface[];
  mongo?: MongoInterface[];
}

export interface Interfaces {
  exposes?: InterfaceGroup;
  consumes?: InterfaceGroup;
  produces?: InterfaceGroup;
  subscribes?: InterfaceGroup;
}

export interface Observability {
  dashboards?: string[];
  alerts?: string[];
  logs?: string[];
  runbooks?: string[];
}

export interface OperationalMetadata {
  source_of_truth?: string[];
  failure_modes?: string[];
  observability?: Observability;
  slo_hints?: string[];
  safe_changes?: string[];
  risky_changes?: string[];
  known_incidents?: string[];
  rollout_notes?: string[];
}

export interface DataOwnershipEntry {
  entity: string;
  source_of_truth: string;
  notes?: string;
}

export interface RepoDep {
  repo: string;
  project?: string;
  reason: string;
}

export interface InfraService {
  name: string;
  port: number;
  target_port: number;
  selector_override?: string;
}

export interface InfraDep {
  type?: string;
  name: string;
  usage?: string;
  version?: string;
  init_script?: string;
  services?: InfraService[];
}

export interface Deployment {
  kustomize_path: string;
  kubernetes_label?: string;
  local?: LocalDeployment;
}

export interface LocalDeployment {
  replicas?: number;
  extra_patches?: unknown[];
}

export interface Fixtures {
  kafka_topics?: string[];
}

export interface PortForward {
  local_port: number;
  target_port?: number;
}

export interface ProjectPortForward {
  service: string;
  local_port: number;
  target_port?: number;
}

export interface Frontend {
  port: number;
  start_command: string;
  hostname?: string;
  start_dir?: string;
  start_env?: Record<string, string>;
  api_deps?: APIDep[];
  mfeconfig_path?: string;
}

export interface APIDep {
  service: string;
  env_key: string;
}

export interface ModuleFederation {
  scope: string;
  remote_entry: string;
  module?: string;
  exposes?: string[];
}

export interface MFEConfig {
  path: string;
  navigation?: MFENav;
}

export interface MFENav {
  hiddenRoutes?: string[];
  collapsedRoutes?: string[];
}

export interface Component {
  name: string;
  type: string;
  language: string;
  path: string;
  runtime_kind?: string;
  description?: string;
  data_ownership?: DataOwnershipEntry[];
  depends_on_repos?: RepoDep[];
  deployment?: Deployment;
  fixtures?: Fixtures;
  interfaces?: Interfaces;
  operational_metadata?: OperationalMetadata;
}

export interface Repo {
  name: string;
  github: string;
  type?: string;
  repo_kind?: string;
  language?: string;
  runtime_kind?: string;
  lifecycle?: string;
  description?: string;
  _source_project?: string;
  components?: Component[];
  data_ownership?: DataOwnershipEntry[];
  depends_on?: InfraDep[];
  depends_on_repos?: RepoDep[];
  deployment?: Deployment;
  frontend?: Frontend;
  fixtures?: Fixtures;
  port_forward?: PortForward;
  module_federation?: ModuleFederation;
  mfeconfig?: MFEConfig;
  interfaces?: Interfaces;
  operational_metadata?: OperationalMetadata;
}

export interface Project {
  schema_version: number;
  project: string;
  title: string;
  owner: string;
  lifecycle: string;
  type?: string;
  tier?: string;
  business_domains?: string[];
  description?: string;
  glossary?: GlossaryEntry[];
  invariants?: Invariant[];
  sharp_edges?: SharpEdge[];
  critical_flows?: CriticalFlow[];
  includes?: string[];
  fixtures_path?: string;
  url_map?: Record<string, string[]>;
  port_forwards?: ProjectPortForward[];
  repos: Repo[];
}

// Helper functions matching Go methods
export function projectType(sys: Project): string {
  return sys.type || 'backend';
}

export function repoCount(sys: Project): number {
  return sys.repos.length;
}

export function isFullstackMFE(sys: Project): boolean {
  return sys.type === 'fullstack-mfe';
}
