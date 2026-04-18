import { Command } from 'commander';
import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import pc from 'picocolors';
import { info, success, error, warn } from '../logger.js';

// ── Provider configuration ───────────────────────────────────────────────

const PROVIDER_ENV_MAP: Record<string, string> = {
  openai: 'OPENAI_API_KEY',
  gemini: 'GOOGLE_API_KEY',
  mistral: 'MISTRAL_API_KEY',
  voyage: 'VOYAGE_API_KEY',
  cohere: 'COHERE_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
};

const VALID_PROVIDERS = Object.keys(PROVIDER_ENV_MAP);

interface AuthEntry {
  key: string;
  addedAt: string;
}

type AuthStore = Record<string, AuthEntry>;

// ── Auth file helpers ────────────────────────────────────────────────────

function getAuthPath(): string {
  return join(homedir(), '.anvil', 'auth.json');
}

function loadAuthStore(): AuthStore {
  const authPath = getAuthPath();
  if (!existsSync(authPath)) return {};
  try {
    return JSON.parse(readFileSync(authPath, 'utf-8'));
  } catch {
    return {};
  }
}

function saveAuthStore(store: AuthStore): void {
  const authPath = getAuthPath();
  const dir = join(homedir(), '.anvil');
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(authPath, JSON.stringify(store, null, 2) + '\n', 'utf-8');
  chmodSync(authPath, 0o600);
}

function maskKey(key: string): string {
  if (key.length <= 8) return '***';
  return key.slice(0, 8) + '...';
}

function formatProviderName(provider: string): string {
  const names: Record<string, string> = {
    openai: 'OpenAI',
    gemini: 'Gemini',
    mistral: 'Mistral',
    voyage: 'Voyage',
    cohere: 'Cohere',
    openrouter: 'OpenRouter',
  };
  return names[provider] || provider;
}

function promptForKey(provider: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const rl = createInterface({
      input: process.stdin,
      output: process.stderr,
    });

    const envVar = PROVIDER_ENV_MAP[provider];
    process.stderr.write(`Enter API key for ${formatProviderName(provider)} (${envVar}): `);

    // Attempt to mask input if TTY
    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
    }

    let input = '';

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      process.stdin.setEncoding('utf-8');

      const onData = (char: string) => {
        const c = char.toString();

        if (c === '\n' || c === '\r' || c === '\u0004') {
          process.stdin.setRawMode(false);
          process.stdin.removeListener('data', onData);
          process.stderr.write('\n');
          rl.close();
          resolve(input.trim());
        } else if (c === '\u0003') {
          // Ctrl+C
          process.stdin.setRawMode(false);
          rl.close();
          reject(new Error('Cancelled'));
        } else if (c === '\u007F' || c === '\b') {
          // Backspace
          if (input.length > 0) {
            input = input.slice(0, -1);
            process.stderr.write('\b \b');
          }
        } else {
          input += c;
          process.stderr.write('*');
        }
      };

      process.stdin.on('data', onData);
    } else {
      // Non-TTY: just read a line
      rl.question('', (answer) => {
        rl.close();
        resolve(answer.trim());
      });
    }
  });
}

// ── Commands ─────────────────────────────────────────────────────────────

export const authCommand = new Command('auth')
  .description('Manage API keys for LLM and embedding providers');

authCommand.addCommand(
  new Command('add')
    .description('Add or update an API key')
    .argument('<provider>', `Provider: ${VALID_PROVIDERS.join(', ')}`)
    .action(async (provider: string) => {
      const normalized = provider.toLowerCase();
      if (!PROVIDER_ENV_MAP[normalized]) {
        error(`Unknown provider "${provider}". Valid providers: ${VALID_PROVIDERS.join(', ')}`);
        process.exitCode = 1;
        return;
      }

      let key: string;
      try {
        key = await promptForKey(normalized);
      } catch {
        info('Cancelled.');
        return;
      }

      if (!key) {
        error('No key provided.');
        process.exitCode = 1;
        return;
      }

      const store = loadAuthStore();
      store[normalized] = {
        key,
        addedAt: new Date().toISOString(),
      };
      saveAuthStore(store);

      // Set in current process
      const envVar = PROVIDER_ENV_MAP[normalized];
      process.env[envVar] = key;

      const displayName = formatProviderName(normalized);
      success(`Added ${displayName} API key.`);
      console.log();
      info(`To make it available project-wide, add to your .zshrc/.bashrc:`);
      console.log(`  ${pc.cyan(`export ${envVar}="${maskKey(key)}"`)}`);
      console.log();
    }),
);

authCommand.addCommand(
  new Command('list')
    .description('Show configured providers')
    .action(async () => {
      const store = loadAuthStore();

      console.log(pc.bold('\nAPI Key Status\n'));

      const colProvider = 14;
      const colEnvVar = 22;
      const colStatus = 10;
      const colKey = 20;

      console.log(
        pc.dim(
          'Provider'.padEnd(colProvider) +
          'Env Var'.padEnd(colEnvVar) +
          'Status'.padEnd(colStatus) +
          'Key Preview',
        ),
      );
      console.log(pc.dim('-'.repeat(colProvider + colEnvVar + colStatus + colKey)));

      for (const provider of VALID_PROVIDERS) {
        const envVar = PROVIDER_ENV_MAP[provider];
        const displayName = formatProviderName(provider);
        const authEntry = store[provider];
        const envValue = process.env[envVar];

        let status: string;
        let keyPreview: string;

        if (authEntry) {
          status = pc.green('set');
          keyPreview = maskKey(authEntry.key);
        } else if (envValue) {
          status = pc.blue('env');
          keyPreview = maskKey(envValue);
        } else {
          status = pc.dim('missing');
          keyPreview = pc.dim('-');
        }

        console.log(
          displayName.padEnd(colProvider) +
          pc.dim(envVar).padEnd(colEnvVar + (pc.dim(envVar).length - envVar.length)) +
          status.padEnd(colStatus + (status.length - (status.replace(/\x1b\[[0-9;]*m/g, '').length))) +
          keyPreview,
        );
      }

      console.log();
      info(`Use ${pc.cyan('anvil auth add <provider>')} to add a key.`);
      console.log();
    }),
);

authCommand.addCommand(
  new Command('remove')
    .description('Remove an API key')
    .argument('<provider>', 'Provider name')
    .action(async (provider: string) => {
      const normalized = provider.toLowerCase();
      if (!PROVIDER_ENV_MAP[normalized]) {
        error(`Unknown provider "${provider}". Valid providers: ${VALID_PROVIDERS.join(', ')}`);
        process.exitCode = 1;
        return;
      }

      const store = loadAuthStore();
      const displayName = formatProviderName(normalized);

      if (!store[normalized]) {
        warn(`No ${displayName} key found in auth store.`);
        return;
      }

      delete store[normalized];
      saveAuthStore(store);

      const envVar = PROVIDER_ENV_MAP[normalized];
      delete process.env[envVar];

      success(`Removed ${displayName} API key from auth store.`);
      console.log();
      info(`If you added it to your shell profile, also remove this line:`);
      console.log(`  ${pc.cyan(`export ${envVar}="..."`)}`);
      console.log();
    }),
);
