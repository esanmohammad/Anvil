/**
 * single-shot's SIGINT/SIGTERM cleanup must not swallow the signal: a process
 * whose only listener is single-shot's has to terminate the way Node would by
 * default, while a host that installs its own listener keeps owning shutdown.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const singleShot = fileURLToPath(new URL('../single-shot.js', import.meta.url));

function runChild(script: string, signal: NodeJS.Signals): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'inherit'] });
    let stdout = '';
    const killer = setTimeout(() => child.kill('SIGKILL'), 10_000);
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
      if (stdout.includes('ready')) child.kill(signal);
    });
    child.on('error', reject);
    child.on('exit', (code, sig) => {
      clearTimeout(killer);
      resolve({ code, signal: sig, stdout });
    });
  });
}

describe('single-shot signal handlers', () => {
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    it(`${sig} still terminates a process that has no listener of its own`, async () => {
      const r = await runChild(
        `await import(${JSON.stringify(singleShot)}); setInterval(() => {}, 1000); console.log('ready');`,
        sig,
      );
      assert.equal(r.signal, sig, `expected death by ${sig}, got code=${r.code} signal=${r.signal}`);
    });
  }

  it('leaves shutdown to a host-installed listener', async () => {
    const r = await runChild(
      `await import(${JSON.stringify(singleShot)});
       process.on('SIGTERM', () => { console.log('host-shutdown'); process.exit(7); });
       setInterval(() => {}, 1000); console.log('ready');`,
      'SIGTERM',
    );
    assert.equal(r.code, 7);
    assert.match(r.stdout, /host-shutdown/);
  });
});
