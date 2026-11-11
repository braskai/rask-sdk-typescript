// Starts the shared acceptance harness (another repository) as a child process, and refuses traffic off this machine.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** RASK_SDK_ACCEPTANCE_DIR, else the sibling checkouts this repository is usually next to. */
export function findHarness() {
  const candidates = [
    process.env.RASK_SDK_ACCEPTANCE_DIR,
    resolve(here, '../../../rask-sdk-acceptance'),
    resolve(here, '../../../../rask-sdk-acceptance'),
  ].filter(Boolean);
  const found = candidates
    .map((directory) => join(directory, 'bin/rask-sdk-acceptance.mjs'))
    .find((path) => existsSync(path));
  if (!found) {
    throw new Error(
      `The acceptance harness was not found. Set RASK_SDK_ACCEPTANCE_DIR. Tried: ${candidates.join(', ')}`,
    );
  }
  return found;
}

const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]']);

/**
 * The default base URL is production, and an SDK bug that loses the custom one would send the test key there. Every
 * test run goes through this, so it fails instead. Uploads on Deno use node:http, but only ever to a URL the harness
 * signed.
 */
export function guardFetch() {
  const real = globalThis.fetch;
  if (real.guarded) return;
  const guarded = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : (input.url ?? input.href));
    if (!LOOPBACK.has(url.hostname)) throw new Error(`Test refused to send a request off this machine: ${url.origin}`);
    return real(input, init);
  };
  guarded.guarded = true;
  globalThis.fetch = guarded;
}

export async function startHarness(extra = []) {
  // The harness itself always runs on Node, whichever runtime the SDK under test is on.
  const child = spawn('node', [findHarness(), '--port', '0', '--other-port', '0', ...extra], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const printed = new Promise((resolvePrinted, reject) => {
    const onData = (chunk) => {
      output += chunk;
      if (/test API key/.test(output) && /\n/.test(output.slice(output.indexOf('test API key')))) resolvePrinted();
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`The harness exited with ${code}: ${output}`)));
  });
  await printed;
  const read = (label) => new RegExp(`${label}\\s+(\\S+)`).exec(output)?.[1];
  const baseUrl = read('base_url');
  return {
    baseUrl,
    control: read('control'),
    otherUrl: read('other host'),
    apiKey: read('test API key'),
    stop: () => child.kill('SIGTERM'),
  };
}
