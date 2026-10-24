/**
 * Project names become directory names under the data dir
 * (`<dataDir>/<project>/`), next to the reserved `daemon/` (sockets + pid
 * files) and `projects/` (P8 registry) directories. Anything that could escape
 * the data dir or collide with those is rejected.
 */

const RESERVED = new Set(['daemon', 'projects']);

export function validateProjectName(name: string): string {
  if (!name || name === '.' || name === '..' || /[/\\\0]/.test(name) || RESERVED.has(name)) {
    throw new Error(
      `Invalid project name ${JSON.stringify(name)}: a project name must be a single path segment ` +
      `(no "/" or "\\", not "." or "..") and not one of the reserved names: ${[...RESERVED].join(', ')}.`,
    );
  }
  return name;
}
