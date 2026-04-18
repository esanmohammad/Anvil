import { readFile } from 'node:fs/promises';
import YAML from 'yaml';
import type { Project, InfraDep, Repo, Component } from './types.js';

function normalizeInfraDeps(deps: unknown[] | undefined): InfraDep[] | undefined {
  if (!deps || !Array.isArray(deps)) return undefined;
  return deps.map((dep) => {
    if (typeof dep === 'string') {
      return { name: dep };
    }
    return dep as InfraDep;
  });
}

function normalizeRepo(repo: any): Repo {
  if (repo.depends_on) {
    repo.depends_on = normalizeInfraDeps(repo.depends_on);
  }
  if (repo.components) {
    repo.components = repo.components.map((c: any) => normalizeComponent(c));
  }
  return repo as Repo;
}

function normalizeComponent(comp: any): Component {
  if (comp.depends_on) {
    comp.depends_on = normalizeInfraDeps(comp.depends_on);
  }
  return comp as Component;
}

/**
 * Normalize a factory.yaml (project format) into the Project shape.
 * factory.yaml uses `project:` instead of `project:`, `version:` instead of
 * `schema_version:`, and nests description/invariants under `domain:`.
 */
function normalizeFactoryFormat(raw: any): any {
  if (raw.project) {
    raw.project = raw.project;
    delete raw.project;
  }
  if (raw.version !== undefined && raw.schema_version === undefined) {
    raw.schema_version = raw.version;
    delete raw.version;
  }
  // factory.yaml nests description and invariants under domain:
  if (raw.domain && typeof raw.domain === 'object') {
    if (raw.domain.description && !raw.description) {
      raw.description = raw.domain.description;
    }
    if (raw.domain.invariants && !raw.invariants) {
      raw.invariants = (raw.domain.invariants as string[]).map((s, i) => ({
        id: `inv-${i + 1}`,
        statement: s,
      }));
    }
    delete raw.domain;
  }
  // Provide defaults for fields required by Project but absent in factory.yaml
  if (!raw.title) raw.title = raw.project;
  if (!raw.owner) raw.owner = '';
  if (!raw.lifecycle) raw.lifecycle = 'active';
  if (!raw.repos) raw.repos = [];
  return raw;
}

export function parseBytes(data: string): Project {
  const raw = YAML.parse(data);
  if (!raw || typeof raw !== 'object') {
    throw new Error('Invalid YAML: expected object');
  }
  // Detect factory.yaml format (has `project:` key) and normalize
  if (raw.project && !raw.project) {
    normalizeFactoryFormat(raw);
  }
  if (raw.repos && Array.isArray(raw.repos)) {
    raw.repos = raw.repos.map((r: any) => normalizeRepo(r));
  }
  return raw as Project;
}

export async function parseFile(path: string): Promise<Project> {
  const data = await readFile(path, 'utf-8');
  return parseBytes(data);
}
