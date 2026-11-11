#!/usr/bin/env node
// A short walk over the API, for a test stand. It needs RASK_API_KEY and RASK_BASE_URL, and never falls back to the
// default URL: that one is production. It prints one line per call, with the status and no secrets, and exits 1 on a failure.
//
//   npm run build
//   RASK_API_KEY=... RASK_BASE_URL=https://stand.example.com/v3 node examples/smoke/smoke.mjs
import { Rask, RaskError } from '../../dist/index.mjs';

for (const name of ['RASK_API_KEY', 'RASK_BASE_URL']) {
  if (!process.env[name]) {
    console.error(`${name} is not set.`);
    process.exit(2);
  }
}

const rask = new Rask();
let failures = 0;

async function step(name, call) {
  const started = Date.now();
  try {
    const result = await call();
    const request = result.requestId ? ` request_id=${result.requestId}` : '';
    console.log(`ok   ${name} status=${result.status}${request} ${Date.now() - started}ms`);
    return result;
  } catch (error) {
    failures += 1;
    if (error instanceof RaskError) {
      const fields = [`status=${error.status}`, `code=${error.code}`, `request_id=${error.requestId}`];
      console.log(`FAIL ${name} ${fields.join(' ')} ${Date.now() - started}ms`);
    } else {
      console.log(`FAIL ${name} ${error?.name ?? 'error'}: ${error?.message ?? error}`);
    }
    return undefined;
  }
}

console.log(`base_url=${rask.config.baseUrl}`);
await step('getMe', () => rask.account.getMe());
await step('listLanguages', () => rask.catalogs.listLanguages());
await step('listVoices ru-ru', async () => rask.voices.listVoices({ query: { target_language: 'ru-ru', limit: 5 } }));

const first = await step('listProjects page 1', async () => rask.projects.listProjects({ query: { limit: 2 } }));
if (first?.hasMore) await step('listProjects page 2', () => first.nextPage());
else if (first) console.log('skip listProjects page 2: there is no second page');

await step('getBalance', () => rask.account.getBalance());
await step('getPlan', () => rask.account.getPlan());

const folder = await step('createFolder', () =>
  rask.projects.createFolder({ body: { name: `sdk-smoke-typescript-${Date.now()}` } }),
);
if (folder) {
  const folderId = folder.data.id;
  await step('getFolder', () => rask.projects.getFolder({ path: { folder_id: folderId } }));
  await step('deleteFolder', () => rask.projects.deleteFolder({ path: { folder_id: folderId } }));
}

console.log(failures === 0 ? 'smoke ok' : `smoke failed: ${failures} call(s)`);
process.exit(failures === 0 ? 0 : 1);
