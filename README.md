# Rask TypeScript SDK

`@braskai/api` is the TypeScript client for the Rask API v3. It runs on Node 22+, Bun and Deno.

This is an alpha, like the API itself.

```sh
npm install @braskai/api
```

```ts
import { Rask } from '@braskai/api';

const rask = new Rask(); // RASK_API_KEY from the environment, or new Rask({ apiKey })
const { data: me, status, requestId } = await rask.account.getMe();
```

On Deno, grant `--allow-net --allow-env`, plus `--allow-read` for uploads from a path. An upload from a stream goes
through a temporary file, so it needs `--allow-read` and `--allow-write` for the temporary directory.

## Base URL

The default is `https://api.rask.ai/v3`. Pass `baseUrl` or set `RASK_BASE_URL`; the argument wins:

```ts
const rask = new Rask({ baseUrl: 'https://gw.example.com/rask/v3' });
```

It applies to every operation and helper. A path prefix stays and a trailing slash makes no difference. Your key goes to
the base URL only. A presigned upload goes without it, and a redirect anywhere else, even on the same host outside the
prefix, drops it.

`Location` headers and `links.*` always say `/v3/...`, as the contract does, so under another prefix they do not resolve
on their own. Use the id instead, as `rask.jobs.wait(job.id)` does.

## Worked example

Upload a video, dub it, wait, download the result (`examples/quickstart.ts`):

```ts
export async function dub(rask: Rask, path: string, targetLanguage: string, outputPath: string) {
  // Progress is saved next to the video, so a run that stops can be started again without paying twice: the media, the
  // price you accepted, createProject's Idempotency-Key and the job it started. Delete the file to dub anew.
  const progressPath = `${path}.${targetLanguage}.json`;
  const saved: { mediaId?: string; maxMinutes?: number; createKey?: string; projectJobId?: string } = JSON.parse(
    await readFile(progressPath, 'utf8').catch(() => '{}'),
  );
  const save = () => writeFile(progressPath, JSON.stringify(saved));

  // Upload the file. completeUpload answers with a media_import job.
  if (saved.mediaId === undefined) {
    const { data: importJob } = await rask.uploads.uploadFile(path, {
      onProgress: (sent, total) => console.log(`uploaded ${Math.round((100 * sent) / total)}%`),
    });
    const { data: imported } = await rask.jobs.wait(importJob.id);
    if (imported.result?.type !== 'media_import') throw new Error('The import has no result.');
    saved.mediaId = imported.result.media_id;
    await save();
  }
  const body = { media_id: saved.mediaId, target_language: targetLanguage };

  // Ask what it costs. That price is the cap: the dub that follows is skipped, uncharged, if it would cost more.
  if (saved.maxMinutes === undefined || saved.createKey === undefined) {
    const { data: estimate } = await rask.projects.estimateProject({ body });
    saved.maxMinutes = estimate.total_minutes;
    saved.createKey = crypto.randomUUID();
    await save();
  }

  // Create the project. It dubs automatically after translation. Sent again with the same key within 24 hours, the
  // request gets the job it already started, not a second project.
  if (saved.projectJobId === undefined) {
    const { data: projectJob } = await rask.projects.createProject({
      body: { ...body, expected_cost_minutes: saved.maxMinutes },
      idempotencyKey: saved.createKey,
    });
    saved.projectJobId = projectJob.id;
    await save();
  }

  // Its job ends when translation ends, and the dub is a job of its own. jobs.wait gives each 4 hours by default.
  const { data: processed } = await rask.jobs.wait(saved.projectJobId);
  if (processed.result?.type !== 'project_processing') throw new Error('The project job has no result.');
  const { project_id: projectId, auto_dub: autoDub } = processed.result;
  if (autoDub.state !== 'dispatched' || autoDub.dub_job_id === null) {
    // skipped: the price or the balance changed after the request, and nothing was charged.
    throw new Error(
      `Project ${projectId} was not dubbed: auto_dub is ${autoDub.state} (${autoDub.skipped_reason}). ` +
        `Call estimateDub, then createDub within the same cap of ${saved.maxMinutes} minutes.`,
    );
  }
  await rask.jobs.wait(autoDub.dub_job_id);

  // Download the result. A presigned URL needs no key, so plain fetch does it.
  const { data: outputs } = await rask.exports.listProjectOutputs({ path: { project_id: projectId } });
  const video = outputs.data.find((output) => output.kind === 'dubbed_video' && output.url);
  if (!video?.url) throw new Error('The project has no dubbed video yet.');
  const download = await fetch(video.url);
  if (!download.ok) throw new Error(`The download answered ${download.status}.`);
  await writeFile(outputPath, new Uint8Array(await download.arrayBuffer()));
  return { projectId, outputPath };
}
```

## Calling the API

All 82 operations are methods named after their `operationId`, grouped by the contract's tags: `account`, `catalogs`,
`dubbing`, `exports`, `glossaries`, `jobs`, `lipsync`, `media`, `onscreen`, `projects`, `segments`, `speakers`,
`transcript`, `uploads`, `usage`, `versions`, `voiceClones` and `voices`. Folders are under `projects`. Each takes one
object, with `path`, `query` and `body` as the contract names them.

A call returns `{ data, status, headers, requestId, idempotencyKey, etag, location, idempotentReplayed }`. `data` is the
JSON as received, so a field, enum value or union variant newer than this SDK is still there. The types list what is known
today; don't treat an `else` branch as impossible.

```ts
const { data: segment, etag } = await rask.segments.getSegment({ path: { project_id, segment_id } });

// ifMatch is required here: without it this does not compile, and at runtime it fails before sending.
await rask.segments.updateSegment({
  path: { project_id, segment_id },
  ifMatch: etag!,
  body: { translation_text: 'Hola' },
});

// "" clears a clearable field. Leave a field out to keep it. Never send null.
await rask.projects.updateProject({ path: { project_id }, body: { folder_id: '' } });
```

### Lists

`await` a list for its first page, or `for await` it for every item of every page:

```ts
for await (const project of rask.projects.listProjects({ query: { limit: 50 } })) console.log(project.id);

const page = await rask.projects.listProjects({ query: { limit: 50 } });
page.items;
page.hasMore;
page.nextCursor;
const next = await page.nextPage(); // null after the last page
```

### Retries and keys

Each call retries 429, 502, 503, 504, connection errors and timeouts, for up to 120 s in all, with backoff from 0.5 s to
30 s and `Retry-After` honoured. A `Retry-After` past that budget ends the retries at once. 500, 409, 412 and 428 are not
retried, except `idempotency_key_in_use`, up to 3 times. Neither is a certificate that fails verification: the call and
`jobs.wait` raise it at once, as a `RaskConnectionError` with the runtime's own error in `cause`.

Every call that takes an `Idempotency-Key` sends a new UUIDv4, the same across its retries. Pass `idempotencyKey` to use
your own. The key that was sent is on the result and on the error.

### Errors

Everything raised is a `RaskError`, with `status`, `code`, `type`, `title`, `detail`, `retryable`, `retry`, `hint`, `errors`,
`requestId`, `idempotencyKey`, `retryAfter`, `headers`, and the whole document in `problem`, members this version does not
know included. Branch on `code`.

| Class                                                                                                            | When                                                         |
| ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `BadRequestError`, `AuthenticationError`, `PermissionDeniedError`, `NotFoundError`, `ConflictError`, `GoneError` | 400, 401, 403, 404, 409, 410                                 |
| `InsufficientBalanceError`                                                                                       | 402, with `creditType`, `requiredMinutes`, `balanceMinutes`  |
| `PreconditionFailedError`, `PreconditionRequiredError`                                                           | 412, with `currentEtag`, and 428                             |
| `PayloadTooLargeError`, `UnsupportedMediaTypeError`, `ValidationError`                                           | 413, 415, 422                                                |
| `RateLimitError`, `InternalServerError`, `ServiceUnavailableError`                                               | 429, 500, and 502 to 504                                     |
| `RaskConnectionError`, `RaskTimeoutError`                                                                        | No whole response arrived                                    |
| `JobFailedError`, `JobCanceledError`, `WaitTimeoutError`                                                         | From `jobs.wait`. Timing out leaves the job running          |
| `UploadFailedError`                                                                                              | From `uploads.uploadFile`, after 3 retries of the whole file |
| `RaskConfigError`                                                                                                | Bad arguments, before any request                            |

### Everything else

- **Timeouts:** 60 s per request by default. Set `timeoutSeconds` on the client or on a call. An upload's PUT times out on
  that much silence, not on its total length.
- **Cancelling:** `signal` on any call, on `jobs.wait` and on `uploads.uploadFile`.
- **Uploads:** `uploadFile` takes a path, a file URL, bytes, a Blob or a stream. A stream is copied to a temporary file
  first, so that a failed PUT can send it again.
- **Debug logs:** `RASK_LOG=debug`, or `logLevel: 'debug'`, logs requests to `console.error` or your `logger`, without the
  key or presigned signatures.
- **Deprecations:** the first `Deprecation` header of an operation warns once, on `console.warn` or your `onDeprecation`.
- **Browsers:** `new Rask()` refuses to run in a browser, where anyone who opens the page can read your key. To accept
  that, pass `dangerouslyAllowBrowser: true`.

On Deno, a connection dropped during an upload's PUT shows up only as the 60 s of silence: Deno's `node:http` does not
report it, and its `fetch` cannot send a stream with the `Content-Length` the URL was signed for.

## Development

```sh
npm ci
npm run generate   # openapi/ -> src/generated/
npm run build
npm run lint
npm test           # needs the acceptance harness; see below
npm run test:ci    # what runs without it
```

`src/generated/` comes from `openapi/openapi.json` (the contract) with `openapi/sdk-fallback.yaml` applied, and `openapi/SOURCE.json`
says which versions. Everything else in `src/` is hand-written. CI fails when `src/generated/` is out of date.

The acceptance tests run against the shared harness, a mock of the API, over real HTTP on a custom base URL. They look for
it next to this checkout, or in `RASK_SDK_ACCEPTANCE_DIR`:

```sh
npm run test:acceptance                  # on src, with Vitest
npm run build && npm run acceptance:bun  # on dist; also acceptance:node, acceptance:deno
RUN_SLOW=1 npm run test:acceptance       # adds the two scenarios that take minutes
```

What only a runtime can show has a check of its own, which needs no harness: that a timeout signal still ends a call and
a wait, and that a certificate which fails verification ends them at the first attempt. It makes throwaway certificates
with `openssl` in a temporary directory, and skips that part where there is no `openssl`:

```sh
npm run build && npm run runtime:bun     # on dist; also runtime:node, runtime:deno
```

To try a test stand, `RASK_API_KEY=... RASK_BASE_URL=... node examples/smoke/smoke.mjs` after a build makes a few real calls.
It creates one folder and deletes it again.

## License

MIT. See [LICENSE](LICENSE).
