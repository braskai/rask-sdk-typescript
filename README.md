# Rask AI TypeScript SDK

Official TypeScript/JavaScript client for the [Rask AI API](https://docs.api.rask.ai/introduction): upload media, dub and translate videos, edit transcriptions, manage glossaries and run lip-sync.

- Typed end to end: request and response types are generated from the OpenAPI spec.
- No runtime dependencies. It uses the standard `fetch` API and runs on Node.js 18+, Bun, Deno and edge runtimes.
- Ships ESM and CommonJS builds with type declarations.
- Built-in OAuth2 client credentials auth: tokens are cached, refreshed before expiry and refreshed once more when the API answers `401`.

> **Server-side only.** The client secret grants full access to your Rask account. Never ship it to browsers or mobile apps; call the API from your backend.

## Installation

```sh
npm install @braskai/rask-sdk
```

## Authentication

Get your API client ID and secret from your Rask account settings ([how to](https://help.rask.ai/hc/introducing-rask-api-rask-help-center)).

```ts
import { RaskClient } from '@braskai/rask-sdk';

const rask = new RaskClient({
  clientId: process.env.RASK_CLIENT_ID!,
  clientSecret: process.env.RASK_CLIENT_SECRET!,
});
```

The client uses the OAuth2 client credentials grant against `https://rask-prod.auth.us-east-2.amazoncognito.com/oauth2/token` with scopes `api/source api/input api/output api/limit`. It sends `client_id` and `client_secret` in the form body (`client_secret_post`), as the Python SDK does. You never need to call the token endpoint yourself:

- the token is fetched on the first request and cached until shortly before `expires_in`;
- concurrent requests share one token request;
- if the API answers `401`, the token is refreshed and the request is retried once.

To reuse the token elsewhere, call `await rask.getAccessToken()`. Pass `{ forceRefresh: true }` to get a new one.

If you obtain tokens yourself, pass `accessToken` (a string, or a function called before every request) instead of credentials. The SDK never refreshes such a token:

```ts
const rask = new RaskClient({ accessToken: async () => myTokenCache.get() });
```

Other options: `baseUrl` (default `https://api.rask.ai`), `tokenUrl`, `scopes`, and `fetch` (a custom `fetch` used for API and token requests).

## Quickstart

Upload a video by link, create a dubbing project, wait until it is done and read the result:

```ts
import { MediaStatus, ProjectStatus, RaskClient } from '@braskai/rask-sdk';

const rask = new RaskClient({
  clientId: process.env.RASK_CLIENT_ID!,
  clientSecret: process.env.RASK_CLIENT_SECRET!,
});
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// 1. Upload media by link and wait until it is processed
let media = await rask.createMediaLink({ link: 'https://example.com/video.mp4', kind: 'video' });
while (media.status === MediaStatus.PROCESSING) {
  await sleep(10_000);
  media = await rask.getMedia({ media_id: media.id });
}
if (media.status !== MediaStatus.READY) throw new Error('media processing failed');

// 2. Create the project (dubbing starts automatically)
let project = await rask.createProject({ video_id: media.id, dst_lang: 'es' });

// 3. Poll until the translated video is merged; stop on any terminal failure
const failures: (string | null | undefined)[] = [
  ProjectStatus.FAILED,
  ProjectStatus.NO_AUDIO,
  ProjectStatus.NO_WORDS,
  ProjectStatus.FORBIDDEN_LINK,
];
while (project.status !== ProjectStatus.MERGING_DONE) {
  if (failures.includes(project.status) || project.status?.endsWith('_failed')) {
    throw new Error(`project failed: ${project.status}`);
  }
  await sleep(10_000);
  project = await rask.getProject({ project_id: project.id });
}

// 4. Download links
console.log(project.translated_video, project.translated_audio, project.translation_srt_path);
```

Dubbing takes a while; choose a polling interval to match. A runnable version is in [`examples/quickstart.ts`](examples/quickstart.ts). For other workflows (custom transcriptions, glossaries, re-dubbing, speakers, lip-sync), see the [API docs](https://docs.api.rask.ai/workflow/translation).

## Uploading a local file

`createMediaFile` sends `multipart/form-data` with the file in the `data` field. Pass any `Blob` or `File`:

```ts
import { openAsBlob } from 'node:fs'; // Node.js 20+

const data = await openAsBlob('video.mp4', { type: 'video/mp4' }); // file-backed, not read into memory
const media = await rask.createMediaFile({ data, name: 'video.mp4', kind: 'video' });
```

On Node.js 18, use `new Blob([await readFile('video.mp4')], { type: 'video/mp4' })`, which reads the file into memory. If you omit `name`, the server uses the multipart file name: `File.name` for a `File`, otherwise `"blob"`.

You can also upload `.srt` subtitles as a transcription. The SDK always sends the file parts as `src.srt` and `dst.srt`, because the API accepts only file names with a single `.srt` extension:

```ts
const transcription = await rask.createTranscriptionSrt({
  src: await openAsBlob('original.srt'),
  src_lang: 'en',
});
await rask.createProject({ video_id: media.id, dst_lang: 'de', transcript_id: transcription.id });
```

## Calling conventions

- Method names are the OpenAPI `operationId`s; the method list is below.
- Each method takes **one flat object** with its path, query and body fields, using the API's snake_case names, e.g. `rask.getProject({ project_id })` or `rask.patchProject({ project_id, name: 'New name' })`.
- Methods resolve to the parsed response body and throw `RaskApiError` on non-2xx responses.
- An optional second argument sets per-request options, such as an abort signal or extra headers:

  ```ts
  await rask.getProjects({ offset: 0, limit: 50 }, { signal: AbortSignal.timeout(30_000) });
  ```

## Error handling

```ts
import { RaskApiError, RaskAuthError } from '@braskai/rask-sdk';

try {
  await rask.createProject({ video_id: mediaId, dst_lang: 'es' });
} catch (error) {
  if (error instanceof RaskAuthError) {
    // the token endpoint rejected the credentials; error.body is e.g. { error: 'invalid_client' }
  } else if (error instanceof RaskApiError) {
    console.error(error.status); // e.g. 422
    console.error(error.detail); // FastAPI `detail`: a string, or validation errors [{ loc, msg, type }]
    console.error(error.body); // the full parsed error body (or text if not JSON)
  } else {
    throw error; // network failure etc. (the runtime's own fetch error)
  }
}
```

`RaskAuthError` extends `RaskApiError`. The response body has already been read, so use `error.body` instead of `error.response.json()`.

## Types

All schema types and enums are exported:

```ts
import { ProjectStatus, type ProjectGet, type MediaGet, type RaskParams } from '@braskai/rask-sdk';

ProjectStatus.MERGING_DONE; // 'merging_done'
type CreateProjectParams = RaskParams<'createProject'>; // parameter object of a method
```

## Methods

| Method | Request | Returns |
|---|---|---|
| `getCredits()` | `GET /v2/credits` | `Credits` |
| `createMediaFile({ data, name?, kind? })` | `POST /api/library/v1/media` (multipart) | `MediaGet` |
| `createMediaLink({ link, kind?, name? })` | `POST /api/library/v1/media/link` | `MediaGet` |
| `getMedia({ media_id })` | `GET /api/library/v1/media/{media_id}` | `MediaGet` |
| `createProject({ video_id, dst_lang, src_lang?, name?, num_speakers?, transcript_id?, glossary_id? })` | `POST /v2/projects` | `ProjectGet` |
| `getProject({ project_id })` | `GET /v2/projects/{project_id}` | `ProjectGet` |
| `getProjects({ offset, limit, name? })` | `GET /v2/projects` | `ProjectListGet` |
| `patchProject({ project_id, name?, num_speakers?, voice? })` | `PATCH /v2/projects/{project_id}` | `ProjectGet` |
| `generateProject({ project_id })` | `POST /v2/projects/{project_id}/generate` (re-dub) | `ProjectGet` |
| `getProjectVoices({ project_id })` | `GET /v2/projects/{project_id}/voices` | `Voice[]` |
| `getProjectTranscription({ project_id, segment_ids? })` | `GET /v2/projects/{project_id}/transcription` | `TranscriptionGet` |
| `createTranscription({ segments })` | `POST /v2/transcriptions` | `TranscriptionId` |
| `createTranscriptionSrt({ src?, dst?, src_lang?, dst_lang? })` | `POST /v2/transcriptions/srt` (multipart) | `TranscriptionId` |
| `addProjectTranscriptionSegments({ project_id, segments })` | `POST /v2/projects/{project_id}/transcription/segments` | `TranscriptionGet` |
| `patchProjectTranscriptionSegments({ project_id, segments })` | `PATCH /v2/projects/{project_id}/transcription/segments` | `TranscriptionGet` |
| `deleteProjectTranscriptionSegment({ project_id, segment_id })` | `DELETE /v2/projects/{project_id}/transcription/segments/{segment_id}` | `SegmentId` |
| `createGlossary({ name, src_lang, dst_lang, entries })` | `POST /v2/glossaries` | `GlossaryGet` |
| `getGlossary({ glossary_id })` | `GET /v2/glossaries/{glossary_id}` | `GlossaryGet` |
| `updateGlossary({ glossary_id, name, entries })` | `PUT /v2/glossaries/{glossary_id}` | `GlossaryGet` |
| `deleteGlossary({ glossary_id })` | `DELETE /v2/glossaries/{glossary_id}` | `GlossaryIdGet` |
| `runCheckFaceTask({ project_id })` | `PUT /v2/projects/{project_id}/check_face` | `CheckFaceTaskResponse` |
| `runLipsyncTask({ project_id, is_multiple_speakers?, is_free_lipsync? })` | `PUT /v2/projects/{project_id}/lipsync` | `LipsyncTaskResponse` |
| `getLipsyncInfo({ project_id })` | `GET /v2/projects/{project_id}/lipsync` | `LipsyncInfo` |
| `getAccessToken({ forceRefresh? })` | token endpoint (cached) | `string` |

The method names match the [Python SDK](https://github.com/braskai/rask-sdk) in camelCase (`get_project_transcription` becomes `getProjectTranscription`). For endpoint details and language codes, see the [API reference](https://docs.api.rask.ai/languages).

## Development

Building and regenerating need Node.js >= 22.18. The published package runs on Node.js >= 18.

```sh
npm ci
npm run typecheck   # tsc (strict)
npm run lint        # tsc with unused-code checks
npm test            # vitest, fully mocked (no network)
npm run build       # tsdown -> dist/index.{mjs,cjs,d.mts,d.cts}
npm run test:dist   # runtime smoke test of the built package (ESM + CJS)
```

### Regenerating from the OpenAPI spec

The source of truth for the spec is the private repository [`braskai/rask-api-documentation`](https://github.com/braskai/rask-api-documentation). This repo keeps a vendored copy in `openapi/openapi.yml`.

1. Copy the updated spec over `openapi/openapi.yml`.
2. Run `npm run generate`. [`@hey-api/openapi-ts`](https://heyapi.dev) regenerates `src/generated/` as configured in `openapi-ts.config.ts`.
3. Run `npm run typecheck && npm test`, then commit the spec together with `src/generated/`.

Never edit `src/generated/` by hand. The generator config creates a single `RaskApi` class whose method names come from the `operationId`s, uses the bundled fetch client with `throwOnError`, and returns the response body. It also inlines `$ref` request bodies in memory so that body fields become flat method parameters. `src/client.ts` adds authentication, `RaskApiError` mapping and the 401 retry on top. CI fails when `src/generated/` is out of date with the spec.

### Releasing

Releases are published to npm by [`.github/workflows/release.yml`](.github/workflows/release.yml) with [npm trusted publishing](https://docs.npmjs.com/trusted-publishers) (OIDC, no stored npm token, provenance once the repository is public).

1. Bump `version` in `package.json` (and merge it).
2. Create a GitHub Release with the tag `v<version>`, for example `v0.2.0`. For a pre-release, use a pre-release version (`0.2.0-rc.1`) and mark the GitHub Release as a pre-release; it is published under the `next` dist-tag instead of `latest`. The workflow refuses mismatches, because npm never allows publishing the same version twice.
3. The workflow checks that the tag matches `package.json`, runs the checks and runs `npm publish`.

Trusted publisher settings for `@braskai/rask-sdk` on npmjs.com: organization `braskai`, repository `rask-sdk-typescript`, workflow `release.yml`, environment `npm`.

npm can only attach a trusted publisher to a package that already exists. The very first version is therefore published either manually (`npm ci && npm publish --access public` by an `@braskai` org member) or through the workflow with a temporary granular token in the `NPM_TOKEN` secret of the `npm` environment. After that, configure the trusted publisher, delete `NPM_TOKEN`, and set the package's publishing access to "Require two-factor authentication and disallow tokens".

## License

UNLICENSED (proprietary) until a license is chosen.
