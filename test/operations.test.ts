import { readFileSync } from 'node:fs';

import { describe, expect, expectTypeOf, it } from 'vitest';

import { ProjectStatus, RaskApiError, RaskClient, type RaskOperation, type RaskParams } from '../src';
import { API, fakeFetch, json } from './helpers';

const PROJECT_ID = '3f2b8c1e-5d7a-4e2b-9c1d-0a1b2c3d4e5f';
const project = {
  id: PROJECT_ID,
  name: 'demo',
  source_type: 'local',
  status: 'merging_done',
  created_at: '2026-01-01T00:00:00Z',
  translated_video: 'https://cdn.example.test/out.mp4',
};

const setup = (onApi: Parameters<typeof fakeFetch>[0]['onApi'] = () => json({})) => {
  const mock = fakeFetch({ onApi });
  const rask = new RaskClient({ clientId: 'id', clientSecret: 'secret', fetch: mock.fetch });
  const lastCall = () => {
    const call = mock.apiCalls.at(-1);
    if (!call) throw new Error('no API call recorded');
    return call;
  };
  return { rask, mock, lastCall };
};

describe('operation surface', () => {
  it('exposes every operationId from the spec as a RaskClient method', () => {
    const spec = readFileSync(new URL('../openapi/openapi.yml', import.meta.url), 'utf8');
    const operationIds = [...spec.matchAll(/^\s+operationId:\s*(\w+)\s*$/gm)].map((match) => match[1]!);
    expect(operationIds).toHaveLength(23);

    const { rask } = setup();
    for (const operationId of operationIds) {
      expect(typeof (rask as unknown as Record<string, unknown>)[operationId], operationId).toBe('function');
    }
  });
});

describe('request building', () => {
  it('getProjects sends offset, limit and name as query parameters', async () => {
    const list = { total: 1, offset: 0, projects: [project] };
    const { rask, lastCall } = setup(() => json(list));

    await expect(rask.getProjects({ offset: 0, limit: 10, name: 'demo' })).resolves.toEqual(list);
    const call = lastCall();
    expect(call.method).toBe('GET');
    expect(`${call.url.origin}${call.url.pathname}`).toBe(`${API}/v2/projects`);
    expect([...call.url.searchParams]).toEqual([
      ['offset', '0'],
      ['limit', '10'],
      ['name', 'demo'],
    ]);
  });

  it('getProject fills the path parameter and returns the parsed body', async () => {
    const { rask, lastCall } = setup(() => json(project));

    const result = await rask.getProject({ project_id: PROJECT_ID });
    expect(result).toEqual(project);
    expect(result.status).toBe(ProjectStatus.MERGING_DONE);
    expect(lastCall().url.toString()).toBe(`${API}/v2/projects/${PROJECT_ID}`);
  });

  it('getProjectTranscription repeats segment_ids for FastAPI list query params', async () => {
    const { rask, lastCall } = setup(() => json({ segments: [] }));

    await rask.getProjectTranscription({ project_id: PROJECT_ID, segment_ids: ['a1', 'b2'] });
    const call = lastCall();
    expect(call.url.pathname).toBe(`/v2/projects/${PROJECT_ID}/transcription`);
    expect(call.url.search).toBe('?segment_ids=a1&segment_ids=b2');
    expect(call.url.searchParams.getAll('segment_ids')).toEqual(['a1', 'b2']);

    await rask.getProjectTranscription({ project_id: PROJECT_ID });
    expect(lastCall().url.search).toBe('');
  });

  it('createProject posts a JSON body', async () => {
    const { rask, lastCall } = setup(() => json(project));

    await expect(rask.createProject({ video_id: 'media-1', dst_lang: 'es', name: null })).resolves.toEqual(project);
    const call = lastCall();
    expect(call.method).toBe('POST');
    expect(call.url.toString()).toBe(`${API}/v2/projects`);
    expect(call.headers.get('content-type')).toBe('application/json');
    expect(await call.request.json()).toEqual({ video_id: 'media-1', dst_lang: 'es', name: null });
  });

  it('createMediaFile uploads multipart field `data` (+ `name`) with `kind` in the query', async () => {
    const media = { id: 'm1', kind: 'video' };
    const { rask, lastCall } = setup(() => json(media));

    const data = new Blob([new Uint8Array([0, 1, 2, 3])], { type: 'video/mp4' });
    await expect(rask.createMediaFile({ data, name: 'video.mp4', kind: 'video' })).resolves.toEqual(media);

    const call = lastCall();
    expect(call.method).toBe('POST');
    expect(`${call.url.origin}${call.url.pathname}`).toBe(`${API}/api/library/v1/media`);
    expect(call.url.searchParams.get('kind')).toBe('video');
    expect(call.headers.get('content-type')).toMatch(/^multipart\/form-data; boundary=/);
    const form = await call.request.formData();
    expect([...form.keys()].sort()).toEqual(['data', 'name']);
    expect(form.get('name')).toBe('video.mp4');
    const file = form.get('data') as Blob;
    expect(file.type).toBe('video/mp4');
    expect(new Uint8Array(await file.arrayBuffer())).toEqual(new Uint8Array([0, 1, 2, 3]));
  });

  it('createTranscriptionSrt uploads `src`/`dst` files with languages in the query', async () => {
    const transcription = { id: 't1', segments: [] };
    const { rask, lastCall } = setup(() => json(transcription));

    await rask.createTranscriptionSrt({
      src: new Blob(['1\n00:00:00,000 --> 00:00:01,000\nHola\n']),
      dst: new Blob(['1\n00:00:00,000 --> 00:00:01,000\nHello\n']),
      src_lang: 'es',
      dst_lang: 'en',
    });

    const call = lastCall();
    expect(call.url.pathname).toBe('/v2/transcriptions/srt');
    expect(call.url.searchParams.get('src_lang')).toBe('es');
    expect(call.url.searchParams.get('dst_lang')).toBe('en');
    const form = await call.request.formData();
    expect([...form.keys()].sort()).toEqual(['dst', 'src']);
    const src = form.get('src') as File;
    const dst = form.get('dst') as File;
    expect(await src.text()).toContain('Hola');
    expect(await dst.text()).toContain('Hello');
    // The API rejects parts whose file name lacks a single `.srt` extension.
    expect(src.name).toBe('src.srt');
    expect(dst.name).toBe('dst.srt');
  });

  it('createTranscriptionSrt sends only the provided file and retries it intact after a 401', async () => {
    const mock = fakeFetch({
      onApi: (request) =>
        request.headers.get('authorization') === 'Bearer tok-1'
          ? json({ detail: 'expired' }, 401)
          : json({ id: 't1', segments: [] }),
    });
    const rask = new RaskClient({ clientId: 'id', clientSecret: 'secret', fetch: mock.fetch });

    await rask.createTranscriptionSrt({ dst: new Blob(['subs']), dst_lang: 'en' });
    expect(mock.apiCalls).toHaveLength(2);
    const form = await mock.apiCalls[1]!.request.formData();
    expect([...form.keys()]).toEqual(['dst']);
    expect((form.get('dst') as File).name).toBe('dst.srt');
    expect(mock.apiCalls[1]!.url.search).toBe('?dst_lang=en');
  });

  it('runLipsyncTask always sends a JSON body, even when every field is omitted', async () => {
    const { rask, lastCall } = setup(() => json({ tasks_in_lipsync_queue: 0, lipsync_task_status: 'started' }));

    await rask.runLipsyncTask({ project_id: PROJECT_ID });
    expect(lastCall().method).toBe('PUT');
    expect(await lastCall().request.text()).toBe('{}');

    await rask.runLipsyncTask({ project_id: PROJECT_ID, is_multiple_speakers: true });
    expect(await lastCall().request.json()).toEqual({ is_multiple_speakers: true });
  });

  it('bodiless operations send no body', async () => {
    const { rask, lastCall } = setup(() => json(project));

    await rask.generateProject({ project_id: PROJECT_ID });
    expect(lastCall().method).toBe('POST');
    expect(lastCall().url.pathname).toBe(`/v2/projects/${PROJECT_ID}/generate`);
    expect(lastCall().request.body).toBeNull();
  });

  it('uses the right method and path for the remaining operations', async () => {
    const { rask, lastCall } = setup(() => json({ id: 'x' }));
    const cases: Array<[() => Promise<unknown>, string, string]> = [
      [() => rask.createMediaLink({ link: 'https://example.test/v.mp4' }), 'POST', '/api/library/v1/media/link'],
      [() => rask.getMedia({ media_id: 'm1' }), 'GET', '/api/library/v1/media/m1'],
      [() => rask.patchProject({ project_id: 'p1', name: 'renamed' }), 'PATCH', '/v2/projects/p1'],
      [() => rask.getProjectVoices({ project_id: 'p1' }), 'GET', '/v2/projects/p1/voices'],
      [() => rask.createTranscription({ segments: [] }), 'POST', '/v2/transcriptions'],
      [() => rask.addProjectTranscriptionSegments({ project_id: 'p1', segments: [] }), 'POST', '/v2/projects/p1/transcription/segments'],
      [() => rask.patchProjectTranscriptionSegments({ project_id: 'p1', segments: [] }), 'PATCH', '/v2/projects/p1/transcription/segments'],
      [() => rask.deleteProjectTranscriptionSegment({ project_id: 'p1', segment_id: 's1' }), 'DELETE', '/v2/projects/p1/transcription/segments/s1'],
      [() => rask.createGlossary({ name: 'g', src_lang: 'en', dst_lang: 'es', entries: { Hello: 'Hola' } }), 'POST', '/v2/glossaries'],
      [() => rask.getGlossary({ glossary_id: 'g1' }), 'GET', '/v2/glossaries/g1'],
      [() => rask.updateGlossary({ glossary_id: 'g1', name: 'g', entries: {} }), 'PUT', '/v2/glossaries/g1'],
      [() => rask.deleteGlossary({ glossary_id: 'g1' }), 'DELETE', '/v2/glossaries/g1'],
      [() => rask.runCheckFaceTask({ project_id: 'p1' }), 'PUT', '/v2/projects/p1/check_face'],
      [() => rask.getLipsyncInfo({ project_id: 'p1' }), 'GET', '/v2/projects/p1/lipsync'],
      [() => rask.getCredits(), 'GET', '/v2/credits'],
    ];
    for (const [call, method, path] of cases) {
      await call();
      expect(`${lastCall().method} ${lastCall().url.pathname}`).toBe(`${method} ${path}`);
    }
  });

  it('supports a custom baseUrl', async () => {
    const mock = fakeFetch({ onApi: () => json({}) });
    const rask = new RaskClient({ accessToken: 't', baseUrl: 'http://localhost:8000', fetch: mock.fetch });

    await rask.getCredits();
    expect(mock.apiCalls[0]!.url.toString()).toBe('http://localhost:8000/v2/credits');
  });
});

describe('error mapping', () => {
  it('maps a FastAPI 422 validation error to RaskApiError', async () => {
    const body = { detail: [{ loc: ['body', 'dst_lang'], msg: 'Field required', type: 'missing' }] };
    const { rask } = setup(() => json(body, 422));

    const error = await rask.createProject({ video_id: 'v', dst_lang: '' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RaskApiError);
    const apiError = error as RaskApiError;
    expect(apiError.name).toBe('RaskApiError');
    expect(apiError.status).toBe(422);
    expect(apiError.body).toEqual(body);
    expect(apiError.detail).toEqual(body.detail);
    expect(apiError.message).toBe('Rask API request failed with status 422: body.dst_lang: Field required');
    expect(apiError.response?.status).toBe(422);
    expect(apiError.request?.url).toBe(`${API}/v2/projects`);
  });

  it('exposes a string detail', async () => {
    const { rask } = setup(() => json({ status: 'not_found', status_code: 404, detail: 'Media not found' }, 404));

    await expect(rask.getMedia({ media_id: 'missing' })).rejects.toMatchObject({
      status: 404,
      detail: 'Media not found',
      message: 'Rask API request failed with status 404: Media not found',
    });
  });

  it('keeps a non-JSON error body as text', async () => {
    const { rask } = setup(() => new Response('upstream connect error', { status: 502 }));

    await expect(rask.getCredits()).rejects.toMatchObject({
      status: 502,
      body: 'upstream connect error',
      detail: undefined,
    });
  });

  it('lets network errors propagate unchanged', async () => {
    const { rask } = setup(() => {
      throw new TypeError('fetch failed');
    });

    const error = await rask.getCredits().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(error).not.toBeInstanceOf(RaskApiError);
  });
});

describe('type helpers', () => {
  it('RaskOperation lists the operations and RaskParams resolves their parameters', () => {
    // Checked by `npm run typecheck` (tsc includes test/).
    expectTypeOf<Extract<RaskOperation, 'getAccessToken' | 'createProject'>>().toEqualTypeOf<'createProject'>();
    expectTypeOf<RaskParams<'getProject'>>().toEqualTypeOf<{ project_id: string }>();
    const params: RaskParams<'getProjects'> = { offset: 0, limit: 10 };
    expect(params.limit).toBe(10);
  });
});
