import { readdir, stat } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { parseFile } from './parser.js';
import type { Project } from './types.js';

/**
 * Derive the projects/ directory from the projects/ directory.
 * Both live under the same Anvil home: ~/.anvil/systems and ~/.anvil/projects.
 */
function projectsDirFrom(projectsDir: string): string {
  return join(dirname(projectsDir), 'projects');
}

/**
 * Scan a directory for sub-directories containing a given YAML config file.
 */
async function scanDir(baseDir: string, yamlName: string): Promise<Project[]> {
  const entries = await readdir(baseDir).catch(() => [] as string[]);
  const projects: Project[] = [];

  for (const entry of entries) {
    const dirPath = join(baseDir, entry);
    const dirStat = await stat(dirPath).catch(() => null);
    if (!dirStat || !dirStat.isDirectory()) continue;

    const yamlPath = join(dirPath, yamlName);
    try {
      const sys = await parseFile(yamlPath);
      projects.push(sys);
    } catch {
      // Skip unparseable
    }
  }

  return projects;
}

export async function loadAll(projectsDir: string): Promise<Project[]> {
  // Scan both projects/ (project.yaml) and projects/ (factory.yaml)
  const [fromLegacy, fromFactory] = await Promise.all([
    scanDir(projectsDir, 'project.yaml'),
    scanDir(projectsDirFrom(projectsDir), 'factory.yaml'),
  ]);

  // Deduplicate: factory.yaml takes priority over project.yaml when names collide
  const seen = new Set<string>();
  const projects: Project[] = [];

  for (const sys of fromFactory) {
    seen.add(sys.project);
    projects.push(sys);
  }
  for (const sys of fromLegacy) {
    if (!seen.has(sys.project)) {
      seen.add(sys.project);
      projects.push(sys);
    }
  }

  return projects.sort((a, b) => a.project.localeCompare(b.project));
}

export async function findProject(projectsDir: string, name: string): Promise<Project> {
  // 1. Try projects/<name>/project.yaml (original path)
  const projectYamlPath = join(projectsDir, name, 'project.yaml');
  try {
    return await parseFile(projectYamlPath);
  } catch {
    // Not found in projects/, fall through
  }

  // 2. Try projects/<name>/factory.yaml
  const factoryYamlPath = join(projectsDirFrom(projectsDir), name, 'factory.yaml');
  try {
    return await parseFile(factoryYamlPath);
  } catch {
    throw new Error(
      `Project "${name}" not found at ${projectYamlPath} or ${factoryYamlPath}`,
    );
  }
}

export async function resolveIncludes(
  sys: Project,
  projectsDir: string,
  _visited?: Set<string>,
): Promise<void> {
  if (!sys.includes || sys.includes.length === 0) return;

  const visited = _visited || new Set<string>([sys.project]);
  const existingRepos = new Set(sys.repos.map((r) => r.name));

  for (const includeName of sys.includes) {
    if (visited.has(includeName)) {
      throw new Error(`Circular include detected: ${sys.project} -> ${includeName}`);
    }

    visited.add(includeName);
    const included = await findProject(projectsDir, includeName);

    // Recursively resolve the included project's includes
    await resolveIncludes(included, projectsDir, new Set(visited));

    for (const repo of included.repos) {
      if (!existingRepos.has(repo.name)) {
        sys.repos.push({ ...repo, _source_project: includeName });
        existingRepos.add(repo.name);
      }
    }
  }
}

export async function findAndResolve(projectsDir: string, name: string): Promise<Project> {
  const sys = await findProject(projectsDir, name);
  await resolveIncludes(sys, projectsDir);
  return sys;
}
