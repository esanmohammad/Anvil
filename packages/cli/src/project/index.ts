export {
  CURRENT_SCHEMA_VERSION,
  VALID_SYSTEM_LIFECYCLES,
  VALID_SYSTEM_TYPES,
  VALID_TIERS,
  VALID_REPO_TYPES,
  VALID_REPO_KINDS,
  VALID_RUNTIME_KINDS,
  VALID_SHARP_EDGE_SEVERITIES,
  VALID_INVARIANT_CRITICALITIES,
} from './enums.js';
export type {
  SystemLifecycle,
  ProjectType,
  Tier,
  RepoType,
  RepoKind,
  RuntimeKind,
  SharpEdgeSeverity,
  InvariantCriticality,
} from './enums.js';

export type {
  GlossaryEntry,
  Invariant,
  SharpEdge,
  FlowStep,
  CriticalFlow,
  HTTPInterface,
  KafkaInterface,
  RedisPubSubInterface,
  RedisListInterface,
  MongoInterface,
  InterfaceGroup,
  Interfaces,
  Observability,
  OperationalMetadata,
  DataOwnershipEntry,
  RepoDep,
  InfraService,
  InfraDep,
  Deployment,
  LocalDeployment,
  Fixtures,
  PortForward,
  ProjectPortForward,
  Frontend,
  APIDep,
  ModuleFederation,
  MFEConfig,
  MFENav,
  Component,
  Repo,
  Project,
} from './types.js';
export { projectType, repoCount, isFullstackMFE } from './types.js';

export { parseBytes, parseFile } from './parser.js';
export { loadAll, findProject, resolveIncludes, findAndResolve } from './loader.js';
export { validateProject, validateAll, formatError } from './validate.js';
export type { ValidationError } from './validate.js';
