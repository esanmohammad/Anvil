import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
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
import type {
  Project,
  Repo,
  Component,
  InterfaceGroup,
  DataOwnershipEntry,
  InfraDep,
} from './types.js';
import { isSupported, isCloudOnly } from '../infra/types.js';

export interface ValidationError {
  project: string;
  repo: string;
  field: string;
  message: string;
}

export function formatError(e: ValidationError): string {
  if (e.repo) {
    return `[${e.project}] repo "${e.repo}": ${e.field}: ${e.message}`;
  }
  return `[${e.project}] ${e.field}: ${e.message}`;
}

function addError(
  errors: ValidationError[],
  project: string,
  repo: string,
  field: string,
  message: string,
): void {
  errors.push({ project, repo, field, message });
}

function validateEnumField(
  errors: ValidationError[],
  project: string,
  repo: string,
  field: string,
  value: string | undefined,
  allowed: readonly string[],
): void {
  if (value !== undefined && value !== '' && !allowed.includes(value)) {
    addError(errors, project, repo, field, `invalid value "${value}", must be one of: ${allowed.join(', ')}`);
  }
}

function validateRequiredString(
  errors: ValidationError[],
  project: string,
  repo: string,
  field: string,
  value: string | undefined,
): void {
  if (!value || value.trim() === '') {
    addError(errors, project, repo, field, 'required but missing or empty');
  }
}

function validateInterfaces(
  errors: ValidationError[],
  project: string,
  repo: string,
  group: InterfaceGroup | undefined,
  prefix: string,
): void {
  if (!group) return;
  if (group.http) {
    group.http.forEach((h, i) => {
      if (!h.name) addError(errors, project, repo, `${prefix}.http[${i}].name`, 'required');
    });
  }
  if (group.kafka) {
    group.kafka.forEach((k, i) => {
      if (!k.topic) addError(errors, project, repo, `${prefix}.kafka[${i}].topic`, 'required');
    });
  }
  if (group.redis_pubsub) {
    group.redis_pubsub.forEach((r, i) => {
      if (!r.name) addError(errors, project, repo, `${prefix}.redis_pubsub[${i}].name`, 'required');
    });
  }
  if (group.redis_lists) {
    group.redis_lists.forEach((r, i) => {
      if (!r.name) addError(errors, project, repo, `${prefix}.redis_lists[${i}].name`, 'required');
    });
  }
  if (group.mongo) {
    group.mongo.forEach((m, i) => {
      if (!m.collection) addError(errors, project, repo, `${prefix}.mongo[${i}].collection`, 'required');
    });
  }
}

function validateAllInterfaces(
  errors: ValidationError[],
  project: string,
  repo: string,
  ifaces: { exposes?: InterfaceGroup; consumes?: InterfaceGroup; produces?: InterfaceGroup; subscribes?: InterfaceGroup } | undefined,
  prefix: string,
): void {
  if (!ifaces) return;
  validateInterfaces(errors, project, repo, ifaces.exposes, `${prefix}.exposes`);
  validateInterfaces(errors, project, repo, ifaces.consumes, `${prefix}.consumes`);
  validateInterfaces(errors, project, repo, ifaces.produces, `${prefix}.produces`);
  validateInterfaces(errors, project, repo, ifaces.subscribes, `${prefix}.subscribes`);
}

function validateDataOwnership(
  errors: ValidationError[],
  project: string,
  repo: string,
  entries: DataOwnershipEntry[] | undefined,
  prefix: string,
): void {
  if (!entries) return;
  entries.forEach((e, i) => {
    if (!e.entity) addError(errors, project, repo, `${prefix}[${i}].entity`, 'required');
    if (!e.source_of_truth) addError(errors, project, repo, `${prefix}[${i}].source_of_truth`, 'required');
  });
}

function validateInfraDeps(
  errors: ValidationError[],
  project: string,
  repo: string,
  deps: InfraDep[] | undefined,
): void {
  if (!deps) return;
  deps.forEach((dep, i) => {
    const effectiveType = dep.type || dep.name;
    if (!isSupported(effectiveType) && !isCloudOnly(effectiveType)) {
      addError(errors, project, repo, `depends_on[${i}]`, `unsupported infrastructure type "${effectiveType}"`);
    }
  });
}

function validateComponent(
  errors: ValidationError[],
  sysName: string,
  repoName: string,
  comp: Component,
  index: number,
): void {
  const prefix = `components[${index}]`;
  validateRequiredString(errors, sysName, repoName, `${prefix}.name`, comp.name);
  validateRequiredString(errors, sysName, repoName, `${prefix}.type`, comp.type);
  validateRequiredString(errors, sysName, repoName, `${prefix}.path`, comp.path);
  validateRequiredString(errors, sysName, repoName, `${prefix}.language`, comp.language);
  validateEnumField(errors, sysName, repoName, `${prefix}.runtime_kind`, comp.runtime_kind, VALID_RUNTIME_KINDS);

  if (comp.deployment && !comp.deployment.kustomize_path) {
    addError(errors, sysName, repoName, `${prefix}.deployment.kustomize_path`, 'required when deployment is set');
  }

  validateAllInterfaces(errors, sysName, repoName, comp.interfaces, `${prefix}.interfaces`);
  validateDataOwnership(errors, sysName, repoName, comp.data_ownership, `${prefix}.data_ownership`);
}

export function validateProject(
  sys: Project,
  projectsDir?: string,
  dirName?: string,
): ValidationError[] {
  const errors: ValidationError[] = [];
  const sysName = sys.project || '(unknown)';

  // Schema version
  if (!sys.schema_version) {
    addError(errors, sysName, '', 'schema_version', 'required');
  } else if (sys.schema_version <= 0) {
    addError(errors, sysName, '', 'schema_version', 'must be > 0');
  } else if (sys.schema_version > CURRENT_SCHEMA_VERSION) {
    addError(errors, sysName, '', 'schema_version', `must be <= ${CURRENT_SCHEMA_VERSION}`);
  }

  // Project-level required fields
  validateRequiredString(errors, sysName, '', 'project', sys.project);
  validateRequiredString(errors, sysName, '', 'title', sys.title);
  validateRequiredString(errors, sysName, '', 'owner', sys.owner);
  validateRequiredString(errors, sysName, '', 'lifecycle', sys.lifecycle);

  // Project-level enums
  validateEnumField(errors, sysName, '', 'lifecycle', sys.lifecycle, VALID_SYSTEM_LIFECYCLES);
  validateEnumField(errors, sysName, '', 'type', sys.type, VALID_SYSTEM_TYPES);
  validateEnumField(errors, sysName, '', 'tier', sys.tier, VALID_TIERS);

  // Directory name match
  if (dirName && sys.project && sys.project !== dirName) {
    addError(errors, sysName, '', 'project', `name "${sys.project}" does not match directory "${dirName}"`);
  }

  // Repos required
  if (!sys.repos || sys.repos.length === 0) {
    addError(errors, sysName, '', 'repos', 'at least one repo is required');
  }

  // Glossary
  if (sys.glossary) {
    const terms = new Set<string>();
    sys.glossary.forEach((g, i) => {
      if (!g.term) addError(errors, sysName, '', `glossary[${i}].term`, 'required');
      if (!g.definition) addError(errors, sysName, '', `glossary[${i}].definition`, 'required');
      if (g.term && terms.has(g.term)) {
        addError(errors, sysName, '', `glossary[${i}].term`, `duplicate term "${g.term}"`);
      }
      if (g.term) terms.add(g.term);
    });
  }

  // Invariants
  if (sys.invariants) {
    const ids = new Set<string>();
    sys.invariants.forEach((inv, i) => {
      if (!inv.id) addError(errors, sysName, '', `invariants[${i}].id`, 'required');
      if (!inv.statement) addError(errors, sysName, '', `invariants[${i}].statement`, 'required');
      validateEnumField(errors, sysName, '', `invariants[${i}].criticality`, inv.criticality, VALID_INVARIANT_CRITICALITIES);
      if (inv.id && ids.has(inv.id)) {
        addError(errors, sysName, '', `invariants[${i}].id`, `duplicate id "${inv.id}"`);
      }
      if (inv.id) ids.add(inv.id);
    });
  }

  // Sharp edges
  if (sys.sharp_edges) {
    const ids = new Set<string>();
    sys.sharp_edges.forEach((se, i) => {
      if (!se.id) addError(errors, sysName, '', `sharp_edges[${i}].id`, 'required');
      if (!se.statement) addError(errors, sysName, '', `sharp_edges[${i}].statement`, 'required');
      validateEnumField(errors, sysName, '', `sharp_edges[${i}].severity`, se.severity, VALID_SHARP_EDGE_SEVERITIES);
      if (se.id && ids.has(se.id)) {
        addError(errors, sysName, '', `sharp_edges[${i}].id`, `duplicate id "${se.id}"`);
      }
      if (se.id) ids.add(se.id);
    });
  }

  // Critical flows
  if (sys.critical_flows) {
    const ids = new Set<string>();
    sys.critical_flows.forEach((cf, i) => {
      if (!cf.id) addError(errors, sysName, '', `critical_flows[${i}].id`, 'required');
      if (!cf.name) addError(errors, sysName, '', `critical_flows[${i}].name`, 'required');
      if (cf.id && ids.has(cf.id)) {
        addError(errors, sysName, '', `critical_flows[${i}].id`, `duplicate id "${cf.id}"`);
      }
      if (cf.id) ids.add(cf.id);
      if (cf.steps) {
        cf.steps.forEach((step, si) => {
          if (!step.component) addError(errors, sysName, '', `critical_flows[${i}].steps[${si}].component`, 'required');
          if (!step.action) addError(errors, sysName, '', `critical_flows[${i}].steps[${si}].action`, 'required');
        });
      }
    });
  }

  // Includes validation
  if (sys.includes && projectsDir) {
    const visited = new Set<string>([sys.project]);
    for (const inc of sys.includes) {
      if (visited.has(inc)) {
        addError(errors, sysName, '', 'includes', `circular include: ${inc}`);
        continue;
      }
      const incPath = join(projectsDir, inc, 'project.yaml');
      if (!existsSync(incPath)) {
        addError(errors, sysName, '', 'includes', `included project "${inc}" not found`);
      }
      visited.add(inc);
    }
  }

  // Repo validation
  const repoNames = new Set<string>();
  const portSet = new Set<number>();

  if (sys.repos) {
    const githubRegex = /^[^/]+\/[^/]+$/;

    sys.repos.forEach((repo, ri) => {
      // Required fields
      validateRequiredString(errors, sysName, repo.name || `repos[${ri}]`, 'name', repo.name);

      if (!repo.github) {
        addError(errors, sysName, repo.name || `repos[${ri}]`, 'github', 'required');
      } else if (!githubRegex.test(repo.github)) {
        addError(errors, sysName, repo.name || `repos[${ri}]`, 'github', `invalid format "${repo.github}", expected "owner/repo"`);
      }

      // Duplicate name check
      if (repo.name && repoNames.has(repo.name)) {
        addError(errors, sysName, repo.name, 'name', `duplicate repo name "${repo.name}"`);
      }
      if (repo.name) repoNames.add(repo.name);

      // Enum fields
      validateEnumField(errors, sysName, repo.name || '', 'type', repo.type, VALID_REPO_TYPES);
      validateEnumField(errors, sysName, repo.name || '', 'repo_kind', repo.repo_kind, VALID_REPO_KINDS);
      validateEnumField(errors, sysName, repo.name || '', 'runtime_kind', repo.runtime_kind, VALID_RUNTIME_KINDS);

      // Deployment
      if (repo.deployment && !repo.deployment.kustomize_path) {
        addError(errors, sysName, repo.name || '', 'deployment.kustomize_path', 'required when deployment is set');
      }

      // Frontend
      if (repo.frontend) {
        if (!repo.frontend.port) addError(errors, sysName, repo.name || '', 'frontend.port', 'required when frontend is set');
        if (!repo.frontend.start_command) addError(errors, sysName, repo.name || '', 'frontend.start_command', 'required when frontend is set');
      }

      // Port conflict
      if (repo.port_forward) {
        const lp = repo.port_forward.local_port;
        if (lp && portSet.has(lp)) {
          addError(errors, sysName, repo.name || '', 'port_forward.local_port', `duplicate port ${lp}`);
        }
        if (lp) portSet.add(lp);
      }

      // Infra deps
      validateInfraDeps(errors, sysName, repo.name || '', repo.depends_on);

      // Interfaces
      validateAllInterfaces(errors, sysName, repo.name || '', repo.interfaces, 'interfaces');

      // Data ownership
      validateDataOwnership(errors, sysName, repo.name || '', repo.data_ownership, 'data_ownership');

      // Components
      if (repo.components) {
        const compNames = new Set<string>();
        repo.components.forEach((comp, ci) => {
          validateComponent(errors, sysName, repo.name || '', comp, ci);
          if (comp.name && compNames.has(comp.name)) {
            addError(errors, sysName, repo.name || '', `components[${ci}].name`, `duplicate component name "${comp.name}"`);
          }
          if (comp.name) compNames.add(comp.name);
        });
      }
    });
  }

  return errors;
}

// Validate all projects in a directory
export async function validateAll(
  projectsDir: string,
): Promise<Map<string, ValidationError[]>> {
  // Import loadAll dynamically to avoid circular deps
  const { loadAll } = await import('./loader.js');
  const projects = await loadAll(projectsDir);
  const results = new Map<string, ValidationError[]>();

  for (const sys of projects) {
    const errors = validateProject(sys, projectsDir, sys.project);
    results.set(sys.project, errors);
  }

  return results;
}
