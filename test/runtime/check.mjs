#!/usr/bin/env node
// What the unit tests cannot show, since they run on Node alone and with a fetch of their own. On whichever runtime
// runs this file (Node, Bun or Deno), against the built package: a timeout signal still ends a call and a wait after
// the SDK has slept between attempts, and a certificate that fails verification ends them at the first attempt.
// The certificates are made here with openssl, in a temporary directory. Without openssl that part is skipped.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import https from 'node:https';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import tls from 'node:tls';
import { Rask, RaskConnectionError, RaskTimeoutError, WaitTimeoutError } from '../../dist/index.mjs';
import { guardFetch } from '../acceptance/harness.mjs';

guardFetch();
const KEY = 'raskai_test_key_NotARealCredential';
let failed = 0;

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** How a promise ended. One that has not ended within `ms` is the failure looked for here, so it must not hang this. */
const outcome = (promise, ms) =>
  Promise.race([
    promise.then(
      (value) => ({ value }),
      (error) => ({ error }),
    ),
    pause(ms).then(() => {
      throw new Error(`still running after ${ms} ms`);
    }),
  ]);

async function check(name, run) {
  const started = Date.now();
  try {
    const note = await run();
    console.log(`ok   ${name} (${Date.now() - started} ms)${note ? `: ${note}` : ''}`);
  } catch (error) {
    failed += 1;
    console.log(`FAIL ${name} (${Date.now() - started} ms): ${error.message}`);
  }
}

/** A client, and the requests it sent: the debug log has one `>` line for each. */
const client = (baseUrl, fetch) => {
  const sent = [];
  const logger = (line) => {
    if (line.startsWith('[rask] > ')) sent.push(line);
  };
  return { rask: new Rask({ apiKey: KEY, baseUrl, fetch, logLevel: 'debug', logger }), sent };
};

// Timeout signals. Nothing is sent: the fetch answers by itself.
const OFFLINE = 'http://127.0.0.1:9/v3';
// Bun 1.3 spares a timeout signal for as long as an AbortSignal.any made from it is not collected, and each attempt of
// a call makes one. Collecting them while the SDK waits makes a failure here certain, where it was only likely.
const collectSoon = () => setTimeout(() => globalThis.Bun?.gc(true), 50);
const busy = async () => {
  collectSoon();
  return new Response('', { status: 503 });
};

await check("a caller's AbortSignal.timeout() ends a call that is retrying", async () => {
  const signal = AbortSignal.timeout(1200);
  const { rask, sent } = client(OFFLINE, busy);
  const { error } = await outcome(rask.account.getMe({ signal }), 4000);
  assert.equal(error, signal.reason);
  // The first wait between attempts is over by then, and with it the listening that Bun 1.3 does not forgive.
  assert.ok(sent.length >= 2, `${sent.length} attempt(s)`);
});

await check('the deadline of jobs.wait ends a wait through an outage', async () => {
  const { error } = await outcome(client(OFFLINE, busy).rask.jobs.wait('job-1', { timeoutSeconds: 1.2 }), 4000);
  assert.ok(error instanceof WaitTimeoutError, String(error));
});

await check('the deadline of jobs.wait ends a poll that hangs', async () => {
  let polls = 0;
  const fetch = (_url, init) => {
    polls += 1;
    if (polls > 1) {
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(init.signal.reason));
      });
    }
    collectSoon();
    const headers = { 'Content-Type': 'application/json', 'Retry-After': '0.2' };
    return Promise.resolve(new Response(JSON.stringify({ id: 'job-1', status: 'running' }), { headers }));
  };
  const { error } = await outcome(client(OFFLINE, fetch).rask.jobs.wait('job-1', { timeoutSeconds: 1.2 }), 4000);
  assert.ok(error instanceof WaitTimeoutError, String(error));
  assert.equal(polls, 2);
});

// Connections and certificates, over real TLS on this machine.

/** Throwaway keys and certificates, written under `directory` and nowhere else. Undefined where there is no openssl. */
function makeCertificates(directory) {
  const openssl = (...args) => execFileSync('openssl', args, { cwd: directory, stdio: 'pipe' });
  try {
    openssl('version');
  } catch {
    return undefined;
  }
  const config = (commonName) =>
    [
      '[req]\ndistinguished_name = dn\nprompt = no',
      `[dn]\nCN = ${commonName}`,
      '[authority]\nbasicConstraints = critical,CA:TRUE',
      '[here]\nsubjectAltName = IP:127.0.0.1',
      '[elsewhere]\nsubjectAltName = DNS:elsewhere.test',
      '[ca]\ndefault_ca = issuer',
      '[issuer]\ndatabase = index.txt\nserial = serial\nnew_certs_dir = .\ndefault_md = sha256\npolicy = any',
      '[any]\ncommonName = supplied',
      '',
    ].join('\n');
  writeFileSync(join(directory, 'authority.cnf'), config('rask-sdk runtime check authority'));
  writeFileSync(join(directory, 'leaf.cnf'), config('rask-sdk runtime check'));
  writeFileSync(join(directory, 'index.txt'), '');
  // The same subject is issued more than once.
  writeFileSync(join(directory, 'index.txt.attr'), 'unique_subject = no\n');
  writeFileSync(join(directory, 'serial'), '01\n');
  const read = (name) => readFileSync(join(directory, name), 'utf8');
  const newKey = (name) => ['-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`];
  const asAuthority = ['-config', 'authority.cnf', '-extensions', 'authority'];
  openssl('req', '-x509', ...newKey('authority'), '-out', 'authority.pem', '-days', '2', ...asAuthority);
  // `openssl ca` is the one way to set the dates that LibreSSL and OpenSSL share.
  const issue = (name, extensions, ...how) => {
    openssl('req', '-new', ...newKey(name), '-out', `${name}.csr`, '-config', 'leaf.cnf');
    const request = ['-in', `${name}.csr`, '-out', `${name}.pem`, '-extensions', extensions];
    openssl('ca', '-batch', '-notext', '-config', 'leaf.cnf', ...request, ...how);
    return { key: read(`${name}.key`), cert: read(`${name}.pem`) };
  };
  const byItself = (name) => ['-selfsign', '-keyfile', `${name}.key`];
  const byAuthority = ['-cert', 'authority.pem', '-keyfile', 'authority.key'];
  const now = ['-days', '2'];
  const longAgo = ['-startdate', '20200101000000Z', '-enddate', '20200102000000Z'];
  return {
    authority: read('authority.pem'),
    selfSigned: issue('self-signed', 'here', ...byItself('self-signed'), ...now),
    expired: issue('expired', 'here', ...byItself('expired'), ...longAgo),
    issued: issue('issued', 'here', ...byAuthority, ...now),
    elsewhere: issue('elsewhere', 'elsewhere', ...byAuthority, ...now),
  };
}

/** A fetch that trusts the throwaway authority, the way this runtime has for it. Undefined where it has none. */
function trusting(authority) {
  if ('Deno' in globalThis) {
    const httpClient = globalThis.Deno.createHttpClient({ caCerts: [authority] });
    return (url, init) => fetch(url, { ...init, client: httpClient });
  }
  if ('Bun' in globalThis) return (url, init) => fetch(url, { ...init, tls: { ca: authority } });
  // Node's fetch takes no authority for one call. It is added for the process, so this comes after the checks that
  // need the authority unknown. Node before 22.19 cannot add one once it runs.
  if (typeof tls.setDefaultCACertificates !== 'function') return undefined;
  tls.setDefaultCACertificates([...tls.getCACertificates('default'), authority]);
  return (url, init) => fetch(url, init);
}

const listening = (server) => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));

async function serve(certificate) {
  const answer = (_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end('{}');
  };
  const server = await listening(https.createServer(certificate, answer));
  return `https://127.0.0.1:${server.address().port}/v3`;
}

const innermost = (error) => (error?.cause ? innermost(error.cause) : error);

/** A certificate that fails verification is the same on every attempt: one of the call, and one more of the wait. */
const endsAtOnce = (name, baseUrl, fetch) =>
  check(`${name}: a call and a wait end at their first attempt`, async () => {
    const { rask, sent } = client(baseUrl, fetch);
    const call = await outcome(rask.account.getMe(), 4000);
    assert.ok(call.error instanceof RaskConnectionError, String(call.error));
    assert.ok(!(call.error instanceof RaskTimeoutError), String(call.error));
    assert.equal(sent.length, 1, 'attempts of the call');
    const wait = await outcome(rask.jobs.wait('job-1', { timeoutSeconds: 3 }), 5000);
    assert.ok(wait.error instanceof RaskConnectionError, String(wait.error));
    assert.equal(sent.length, 2, 'attempts of the call and the wait');
    const said = innermost(call.error);
    return `the runtime said ${said.code ?? said.message}`;
  });

// What is not about the certificate may pass on a later attempt, and is retried as before.
await check('a refused connection is still retried', async () => {
  const closed = await listening(net.createServer());
  const { port } = closed.address();
  await new Promise((resolve) => closed.close(resolve));
  const { rask, sent } = client(`https://127.0.0.1:${port}/v3`);
  const controller = new AbortController();
  setTimeout(() => controller.abort(new Error('enough')), 1500);
  const { error } = await outcome(rask.account.getMe({ signal: controller.signal }), 4000);
  assert.equal(error?.message, 'enough');
  assert.ok(sent.length >= 2, `${sent.length} attempt(s)`);
});

const directory = mkdtempSync(join(tmpdir(), 'rask-runtime-check-'));
try {
  const certificates = makeCertificates(directory);
  if (!certificates) {
    console.log('skip the certificate checks: openssl was not found');
  } else {
    await endsAtOnce('a self-signed certificate', await serve(certificates.selfSigned));
    await endsAtOnce('an expired certificate', await serve(certificates.expired));
    const issued = await serve(certificates.issued);
    await endsAtOnce('a certificate of an unknown issuer', issued);
    const trust = trusting(certificates.authority);
    if (!trust) {
      console.log('skip the wrong host name: this runtime cannot be told to trust an authority');
    } else {
      // Shows that the authority is trusted from here on, so what fails next is the name and nothing else.
      await check('a certificate of a trusted issuer is accepted', async () => {
        const { value, error } = await outcome(client(issued, trust).rask.account.getMe(), 4000);
        assert.equal(value?.status, 200, String(error));
      });
      await endsAtOnce('a certificate for another host name', await serve(certificates.elsewhere), trust);
    }
  }
} finally {
  rmSync(directory, { recursive: true, force: true });
}
// Open servers, and calls that a failed check left running, must not keep the process alive.
process.exit(failed > 0 ? 1 : 0);
