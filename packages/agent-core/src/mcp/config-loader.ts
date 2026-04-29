/**
 * `mcp.json` discovery + parsing.
 *
 * Search order (locked in ADR §4.3):
 *   1. process.env.ANVIL_MCP_CONFIG (full path)
 *   2. <workspaceRoot>/mcp.json
 *   3. <workspaceRoot>/.mcp/servers.json
 *   4. <workspaceRoot>/.claude/mcp.json
 *   5. $HOME/.claude/mcp.json
 *
 * The first existing file wins; configs do not merge.
 *
 * Each entry's transport is inferred from shape (`command` → stdio,
 * `url` → streamable-http). Entries with both or neither are dropped with a
 * stderr warning.
 *
 * `${env:VAR}` substitutions in env/headers values are expanded against
 * `process.env` (or the provided env override).
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type {
  McpServerConfig,
  McpServerEntry,
  McpServersFile,
} from './types.js';

export interface LoadMcpServersOptions {
  /** Absolute workspace root used for ranks 2–4. */
  workspaceRoot?: string;
  /** Override `process.env`; supports both `ANVIL_MCP_CONFIG` and `${env:VAR}` substitution. */
  env?: NodeJS.ProcessEnv;
  /** Override `$HOME` (test seam). */
  homeDir?: string;
}

/** Returns the path of the canonical `mcp.json` for the workspace, or undefined. */
export function findMcpConfigPath(opts: LoadMcpServersOptions = {}): string | undefined {
  const env = opts.env ?? process.env;
  const home = opts.homeDir ?? homedir();

  const candidates: string[] = [];
  if (env.ANVIL_MCP_CONFIG) candidates.push(env.ANVIL_MCP_CONFIG);
  if (opts.workspaceRoot) {
    candidates.push(
      join(opts.workspaceRoot, 'mcp.json'),
      join(opts.workspaceRoot, '.mcp', 'servers.json'),
      join(opts.workspaceRoot, '.claude', 'mcp.json'),
    );
  }
  candidates.push(join(home, '.claude', 'mcp.json'));

  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return undefined;
}

const ENV_VAR_RE = /\$\{env:([A-Z_][A-Z0-9_]*)\}/g;

function substituteEnvVars(
  value: string,
  env: NodeJS.ProcessEnv,
  fieldDesc: string,
  warn: (msg: string) => void,
): string {
  return value.replace(ENV_VAR_RE, (_match, name: string) => {
    const v = env[name];
    if (v === undefined || v === '') {
      warn(`[anvil-mcp] WARN: env var \${env:${name}} unset — ${fieldDesc} resolves to empty`);
      return '';
    }
    return v;
  });
}

function expandEntryStrings(
  obj: Record<string, string> | undefined,
  env: NodeJS.ProcessEnv,
  fieldDesc: string,
  warn: (msg: string) => void,
): Record<string, string> | undefined {
  if (!obj) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v !== 'string') {
      warn(`[anvil-mcp] WARN: ${fieldDesc}.${k} is not a string; skipping`);
      continue;
    }
    out[k] = substituteEnvVars(v, env, `${fieldDesc}.${k}`, warn);
  }
  return out;
}

function inferTransport(
  entry: McpServerEntry,
  name: string,
  warn: (msg: string) => void,
): 'stdio' | 'streamable-http' | undefined {
  const hasCmd = typeof entry.command === 'string' && entry.command.length > 0;
  const hasUrl = typeof entry.url === 'string' && entry.url.length > 0;
  if (hasCmd && hasUrl) {
    warn(`[anvil-mcp] WARN: server "${name}" has both command and url; dropping`);
    return undefined;
  }
  if (hasCmd) return 'stdio';
  if (hasUrl) return 'streamable-http';
  warn(`[anvil-mcp] WARN: server "${name}" has neither command nor url; dropping`);
  return undefined;
}

/**
 * Read and parse the `mcp.json` for `workspaceRoot`. Returns `[]` when no
 * config is found (graceful no-op for projects without MCP).
 */
export function loadMcpServers(opts: LoadMcpServersOptions = {}): McpServerConfig[] {
  const env = opts.env ?? process.env;
  const path = findMcpConfigPath({ ...opts, env });
  if (!path) return [];

  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch (err) {
    process.stderr.write(`[anvil-mcp] WARN: cannot read ${path}: ${(err as Error).message}\n`);
    return [];
  }

  let parsed: McpServersFile;
  try {
    parsed = JSON.parse(raw) as McpServersFile;
  } catch (err) {
    process.stderr.write(`[anvil-mcp] WARN: ${path} is not valid JSON: ${(err as Error).message}\n`);
    return [];
  }

  if (!parsed.mcpServers || typeof parsed.mcpServers !== 'object') {
    process.stderr.write(`[anvil-mcp] WARN: ${path} missing top-level "mcpServers" object\n`);
    return [];
  }

  const warn = (msg: string) => process.stderr.write(msg + '\n');
  const out: McpServerConfig[] = [];
  for (const [name, entry] of Object.entries(parsed.mcpServers)) {
    if (!entry || typeof entry !== 'object') {
      warn(`[anvil-mcp] WARN: server "${name}" entry is not an object; dropping`);
      continue;
    }
    const transport = inferTransport(entry, name, warn);
    if (!transport) continue;

    out.push({
      name,
      transport,
      command: entry.command,
      args: Array.isArray(entry.args) ? [...entry.args] : undefined,
      env: expandEntryStrings(entry.env, env, `mcpServers.${name}.env`, warn),
      url: entry.url,
      headers: expandEntryStrings(entry.headers, env, `mcpServers.${name}.headers`, warn),
    });
  }
  return out;
}
