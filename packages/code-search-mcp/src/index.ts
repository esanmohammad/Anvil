#!/usr/bin/env node
/**
 * Code Search MCP — multi-repo code intelligence via MCP.
 *
 * DEFAULT MODE (remote proxy):
 *   code-search-mcp                                  # uses CODE_SEARCH_SERVER env
 *   code-search-mcp --remote https://server:3100     # explicit server URL
 *
 * LOCAL MODE (self-hosted, has repos + index locally):
 *   code-search-mcp --local /path/to/repos           # index local repos
 *   code-search-mcp --local github:org-name           # clone from GitHub
 *   code-search-mcp --serve [path]                    # HTTP server mode
 *
 * Environment:
 *   CODE_SEARCH_SERVER            — remote server URL (default mode)
 *   CODE_SEARCH_API_KEY           — API key for remote server
 *   GITHUB_TOKEN                  — for private repos (local mode)
 *   OLLAMA_HOST                   — Ollama endpoint (local mode)
 */

import { resolve, basename, join } from 'node:path';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { printConfig, resolveCodeSearchConfig, parseCliFlags, exportDataDir } from './core/config.js';
import { loadServerConfig } from './core/env-config.js';
import { validateProjectName } from './core/project-name.js';
import { configureLogger, getComponentLogger } from './observability/logger.js';

const log = getComponentLogger('code-search-mcp');

const HELP = `
Code Search MCP — multi-repo code intelligence via MCP

REMOTE MODE (default — connects to a deployed server):
  code-search-mcp                                    Uses CODE_SEARCH_SERVER env
  code-search-mcp --remote https://server:3100       Explicit server URL
  code-search-mcp --remote https://server:3100 --api-key sk-xxx

  Environment:
    CODE_SEARCH_SERVER              Remote server URL
    CODE_SEARCH_API_KEY             API key for authentication

  Claude Desktop config:
    {
      "mcpServers": {
        "code-search": {
          "command": "code-search-mcp",
          "env": {
            "CODE_SEARCH_SERVER": "https://your-server:3100",
            "CODE_SEARCH_API_KEY": "your-api-key"
          }
        }
      }
    }

LOCAL MODE (self-hosted — indexes repos locally, serves over stdio):
  code-search-mcp --local /path/to/repos             Index local directory
  code-search-mcp --local github:org-name             Clone from GitHub org
  code-search-mcp --local --project my-project        Serve existing index

  Options:
    --project <name>        Project name (default: derived from source)
    --token <token>         GitHub token (or GITHUB_TOKEN env)
    --force                 Force a full re-index at startup

SERVER MODE (deploy as HTTP service — Streamable HTTP on /mcp):
  code-search-mcp --serve [path]                      Start HTTP server (project "default")
  code-search-mcp --serve /repos --port 3100 --auth api-key
  (--local <path> --serve and --serve --local <path> are equivalent)

  Options:
    --port <port>           HTTP port (default: 3100) = --server.port
    --host <host>           Bind address = --server.host
    --auth <mode>           none | api-key | jwt = --auth.mode
    --project <name>        Project name (default: "default")

  Environment:
    CODE_SEARCH_PORT                HTTP port (default: 3100)
    CODE_SEARCH_AUTH_MODE           none | api-key | jwt
    CODE_SEARCH_AUTH_API_KEYS       Comma-separated API keys
    CODE_SEARCH_EMBEDDING_PROVIDER  auto | codestral | openai | voyage | ollama | custom
    CODE_SEARCH_EMBEDDING_API_KEY   Unified embedding API key
    CODE_SEARCH_DATA_DIR            Data directory override

CONFIG (every mode):
  --<dotted.path> <value>   Any CodeSearchConfig leaf, e.g. --retrieval.max-chunks 12
  --print-config            Print the resolved config (secrets redacted) and exit
`;

function usageError(msg: string): never {
  log.error(`${msg} — see --help`);
  process.exit(2);
}

// ── Parse arguments ──────────────────────────────────────────────────
// Config flags (`--<dotted.path>`, `--port`, `--auth`, …) are split off by
// parseCliFlags; the mode flags below are order-independent.

const { patch, rest, unknown } = parseCliFlags(process.argv.slice(2));
if (unknown.length) usageError(`unknown flag(s): ${unknown.join(', ')}`);

let printOnly = false;
let serve = false;
let local = false;
let remoteUrl: string | null = null;
let apiKey: string | undefined;
let source: string | null = null;
let projectName: string | null = null;
let githubToken: string | undefined;
let force = false;

for (let i = 0; i < rest.length; i++) {
  const arg = rest[i];
  const value = (): string => {
    const v = rest[i + 1];
    if (v === undefined || v.startsWith('--')) usageError(`${arg} needs a value`);
    i++;
    return v;
  };
  // `--local` / `--serve` take an optional source path.
  const optionalPath = (): string | null => (rest[i + 1] !== undefined && !rest[i + 1].startsWith('-') ? rest[++i] : null);
  switch (arg) {
    case '--print-config': printOnly = true; break;
    case '--remote': remoteUrl = value(); break;
    case '--local': local = true; source = optionalPath() ?? source; break;
    case '--serve': serve = true; source = optionalPath() ?? source; break;
    case '--api-key': apiKey = value(); break;
    case '--project': projectName = value(); break;
    case '--token': githubToken = value(); break;
    case '--force': force = true; break;
    case '--help':
    case '-h':
      process.stderr.write(HELP);
      process.exit(0);
    default:
      if (arg.startsWith('-')) usageError(`unknown flag: ${arg}`);
      // Bare arg — a remote URL, or a local source for backward compat.
      if (/^https?:\/\//.test(arg)) remoteUrl = arg;
      else source = arg;
  }
}

const mode: 'remote' | 'local' | 'serve' = serve ? 'serve' : remoteUrl ? 'remote' : local || source ? 'local' : 'remote';
const workspaceDir = source && !source.startsWith('github:') ? resolve(source) : process.cwd();

const preview = resolveCodeSearchConfig({ cli: patch, workspaceDir });
if ((preview.server.transport as string) === 'sse') {
  usageError('SSE transport is not supported — the server speaks Streamable HTTP on /mcp (drop --transport / CODE_SEARCH_TRANSPORT)');
}
if (mode === 'serve') patch.server = { ...patch.server, transport: 'streamable-http' };

if (printOnly) {
  process.stdout.write(printConfig(resolveCodeSearchConfig({ cli: patch, workspaceDir })) + '\n');
  process.exit(0);
}

configureLogger({ structured: preview.telemetry.structuredLogs });

// ── Execute ──────────────────────────────────────────────────────────

(async () => {
  try {
    // ── REMOTE MODE (default) ──────────────────────────────────────
    if (mode === 'remote') {
      const serverUrl = remoteUrl
        ?? process.env.CODE_SEARCH_SERVER
        ?? process.env.CODE_SEARCH_REMOTE_URL;

      const key = apiKey
        ?? process.env.CODE_SEARCH_API_KEY
        ?? process.env.CODE_SEARCH_AUTH_API_KEY;

      if (!serverUrl) {
        log.error(`No remote server configured.

Set CODE_SEARCH_SERVER environment variable:
  export CODE_SEARCH_SERVER=https://your-server:3100

Or pass it directly:
  code-search-mcp --remote https://your-server:3100

For local use (self-hosted with repos on this machine):
  code-search-mcp --local /path/to/repos

For help:
  code-search-mcp --help
`);
        process.exit(1);
      }

      const { startRemoteProxy } = await import('./transports/remote-proxy.js');
      await startRemoteProxy({ serverUrl, apiKey: key });
      return;
    }

    // ── LOCAL (stdio) / SERVE (HTTP) — same source resolution ──────
    const config = loadServerConfig({ cli: patch, workspaceDir });
    exportDataDir(config.__unified);

    let directoryPath: string | null = null;

    if (source?.startsWith('github:')) {
      const { cloneOrUpdateOrg } = await import('./sources/github-org.js');
      const spec = source.replace('github:', '');
      const slashIdx = spec.indexOf('/');
      const org = slashIdx > 0 ? spec.slice(0, slashIdx) : spec;
      const pattern = slashIdx > 0 ? spec.slice(slashIdx + 1) : undefined;

      if (!projectName && mode === 'local') projectName = org;

      log.info(`Cloning repos from github:${org}${pattern ? `/${pattern}` : ''}...`);
      const repos = await cloneOrUpdateOrg(org, {
        pattern,
        token: githubToken,
        onProgress: (m) => log.info(m),
      });
      log.info(`${repos.length} repos ready`);

      directoryPath = join(homedir(), '.code-search', org);

    } else if (source) {
      directoryPath = resolve(source);
      if (!existsSync(directoryPath)) {
        log.error(`Directory not found: ${directoryPath}`);
        process.exit(1);
      }
    } else if (local && !projectName) {
      directoryPath = process.cwd();
    }

    // Serve mode keeps the historical "default" namespace; stdio local mode
    // names the project after its source directory.
    if (!projectName) {
      projectName = mode === 'serve' ? 'default' : (directoryPath && basename(directoryPath)) || 'project';
    }
    try {
      validateProjectName(projectName);
    } catch (err) {
      usageError((err as Error).message);
    }

    const { startServer } = await import('./server.js');
    await startServer(projectName, directoryPath, { force });
  } catch (err) {
    log.error(`Fatal: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
    process.exit(1);
  }
})();
