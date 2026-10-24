/**
 * The package's own version, read from package.json at runtime so /version,
 * /admin/api/status, MCP serverInfo and the remote proxy never drift from the
 * published release. The build keeps src/ layout under dist/, so this module
 * sits two levels below the package root in both trees.
 */

import { readFileSync } from 'node:fs';

export const PACKAGE_VERSION: string = (
  JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf-8')) as { version: string }
).version;
