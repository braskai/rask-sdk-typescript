import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { Rask, RaskConfigError, RaskError, UploadFailedError, type UploadSource } from '../src/index';
import { BASE, json, type RecordedRequest, stubFetch, TEST_KEY, useHarness } from './helpers';

const SIZE = 3 * 1024 * 1024 + 17;
const bytes = Uint8Array.from({ length: SIZE }, (_, index) => index % 251);
const sha = createHash('sha256').update(bytes).digest('hex');
const scratch = mkdtempSync(join(tmpdir(), 'rask-upload-test-'));
const path = join(scratch, 'clip.mp4');
writeFileSync(path, bytes);
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

const leftovers = () =>
  readdirSync(tmpdir()).filter((name) => name.startsWith('rask-upload-') && !name.includes('test'));

describe('uploads.uploadFile over HTTP', () => {
  const harness = useHarness();
  const client = () => new Rask({ apiKey: harness.apiKey, baseUrl: harness.baseUrl });
  const puts = async () =>
    ((await harness.requests()) as RecordedRequest[]).filter((request) => request.operationId === '__storage_put');
  beforeEach(() => harness.control.post('/reset'));

  it.each<[string, () => UploadSource, object]>([
    ['a path', () => path, {}],
    ['a file URL', () => pathToFileURL(path), {}],
    ['a Uint8Array', () => bytes, { filename: 'clip.mp4' }],
    ['a Buffer', () => Buffer.from(bytes), { filename: 'clip.mp4' }],
    ['an ArrayBuffer', () => bytes.slice().buffer, { filename: 'clip.mp4' }],
    ['a Blob', () => new Blob([bytes]), { filename: 'clip.mp4' }],
    ['a File', () => new File([bytes], 'clip.mp4'), {}],
    ['a web stream', () => new Blob([bytes]).stream() as ReadableStream<Uint8Array>, { filename: 'clip.mp4' }],
    ['a Node stream', () => Readable.from([Buffer.from(bytes)]), { filename: 'clip.mp4' }],
    [
      'an async iterable',
      () =>
        (async function* () {
          yield bytes.subarray(0, 100);
          yield bytes.subarray(100);
        })(),
      { filename: 'clip.mp4' },
    ],
  ])('sends %s whole, with the signed headers and no key', async (_, source, options) => {
    const result = await client().uploads.uploadFile(source(), options);
    expect(result.status).toBe(202);
    const [put, ...others] = await puts();
    expect(others).toEqual([]);
    expect(put?.response.status).toBe(200);
    expect(put?.body_sha256).toBe(sha);
    expect(put?.headers['content-length']).toBe(String(SIZE));
    expect(put?.headers['content-type']).toBe('video/mp4');
    expect(put?.headers.authorization).toBeUndefined();
    expect(put?.headers['transfer-encoding']).toBeUndefined();
    expect(leftovers()).toEqual([]);
  });

  it('reports progress up to the file size, in steps', async () => {
    const seen: Array<[number, number]> = [];
    await client().uploads.uploadFile(path, { onProgress: (sent, total) => seen.push([sent, total]) });
    expect(seen.length).toBeGreaterThan(1);
    expect(seen.at(-1)).toEqual([SIZE, SIZE]);
    expect(seen.map(([sent]) => sent)).toEqual([...seen.map(([sent]) => sent)].sort((a, b) => a - b));
  });

  it('retries a stream with the whole file, from its temporary copy', async () => {
    await harness.control.post('/script', { operationId: '__storage_put', steps: [{ status: 503 }] });
    await client().uploads.uploadFile(Readable.from([Buffer.from(bytes)]), { filename: 'clip.mp4' });
    const seen = await puts();
    expect(seen.map((put) => put.response.status)).toEqual([503, 200]);
    expect(seen.every((put) => put.body_sha256 === sha)).toBe(true);
    expect(leftovers()).toEqual([]);
  });

  it('gives up with UploadFailedError after 4 PUTs and does not complete', async () => {
    await harness.control.post('/script', {
      operationId: '__storage_put',
      steps: [{ status: 503, repeat: 'forever' }],
    });
    const error = await client()
      .uploads.uploadFile(path)
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(UploadFailedError);
    expect(error).toMatchObject({ status: 503, attempts: 4 });
    const all = (await harness.requests()) as RecordedRequest[];
    expect(all.filter((request) => request.operationId === 'completeUpload')).toEqual([]);
  });

  it('does not retry an answer from storage that will not change', async () => {
    await harness.control.post('/script', {
      operationId: '__storage_put',
      steps: [{ status: 403, repeat: 'forever' }],
    });
    await expect(client().uploads.uploadFile(path)).rejects.toMatchObject({ status: 403, attempts: 1 });
    expect(await puts()).toHaveLength(1);
  });

  it('takes the purpose through to createUpload', async () => {
    await client().uploads.uploadFile(path, { purpose: 'voice_sample' });
    const all = (await harness.requests()) as Array<RecordedRequest & { body: { purpose?: string } }>;
    expect(all.find((request) => request.operationId === 'createUpload')?.body.purpose).toBe('voice_sample');
  });
});

describe('uploads.uploadFile before the network', () => {
  it('needs a file name for bytes', async () => {
    const { fetch, calls } = stubFetch([]);
    const rask = new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch });
    await expect(rask.uploads.uploadFile(bytes)).rejects.toThrow('filename');
    expect(calls).toHaveLength(0);
  });

  it('asks for the file name before reading a stream', async () => {
    const { fetch } = stubFetch([]);
    const rask = new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch });
    let read = false;
    const stream = (async function* () {
      read = true;
      yield bytes;
    })();
    await expect(rask.uploads.uploadFile(stream)).rejects.toThrow('filename');
    expect(read).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('needs a content type when the extension says nothing', async () => {
    const { fetch, calls } = stubFetch([]);
    const rask = new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch });
    await expect(rask.uploads.uploadFile(bytes, { filename: 'clip.unknown' })).rejects.toBeInstanceOf(RaskConfigError);
    expect(calls).toHaveLength(0);
  });

  it('refuses what it cannot read', async () => {
    const { fetch } = stubFetch([]);
    const rask = new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch });
    await expect(rask.uploads.uploadFile(42 as unknown as UploadSource)).rejects.toBeInstanceOf(RaskConfigError);
  });
});

describe('uploads.uploadFile with what the API may answer later', () => {
  const upload = (transfer: unknown) => ({ id: 'u1', transfer });

  it('refuses a transfer method it does not know, without sending the file', async () => {
    const { fetch, calls } = stubFetch([json(upload({ method: 'multipart', parts: [] }), 201)]);
    const rask = new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch });
    const error = await rask.uploads.uploadFile(bytes, { filename: 'a.mp4' }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RaskError);
    expect((error as Error).message).toContain('multipart');
    expect(calls).toHaveLength(1);
  });

  it('says what a key without media:write gets', async () => {
    const { fetch } = stubFetch([json(upload(null), 201)]);
    const rask = new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch });
    await expect(rask.uploads.uploadFile(bytes, { filename: 'a.mp4' })).rejects.toThrow('media:write');
  });

  it('drops an Authorization header the API might ever list among the signed ones', async () => {
    const transfer = {
      method: 'single',
      url: 'https://storage.example.com/x?X-Amz-Signature=abc',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      headers: { 'Content-Type': 'video/mp4', 'Content-Length': String(SIZE), Authorization: 'Bearer not-ok' },
    };
    const lines: string[] = [];
    const { fetch, calls } = stubFetch([json(upload(transfer), 201), new Response(''), json({ id: 'job' }, 202)]);
    const rask = new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch, logLevel: 'debug', logger: (l) => lines.push(l) });
    await rask.uploads.uploadFile(bytes, { filename: 'a.mp4' });
    expect(calls[1]?.url).toBe(transfer.url);
    expect(calls[1]?.headers.get('authorization')).toBeNull();
    expect(lines.join('\n')).toContain('storage.example.com/x?[redacted]');
    expect(lines.join('\n')).not.toContain('abc');
  });

  it('adds the length when the API lists no headers, and keeps the signature out of the error', async () => {
    const transfer = {
      method: 'single',
      url: 'https://storage.example.com/x?X-Amz-Signature=abc',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      headers: {},
    };
    const failure = new TypeError(`could not reach ${transfer.url}`);
    const { fetch, calls } = stubFetch([json(upload(transfer), 201), failure, failure, failure, failure]);
    const rask = new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch });
    const error = (await rask.uploads
      .uploadFile(bytes, { filename: 'a.mp4' })
      .catch((caught: unknown) => caught)) as UploadFailedError;
    expect(error).toBeInstanceOf(UploadFailedError);
    expect(error.status).toBeUndefined();
    expect(calls[1]?.headers.get('content-length')).toBe(String(SIZE));
    expect(String(error.cause)).toContain('[redacted]');
    expect(String(error.cause)).not.toContain('abc');
  });

  it('notices a stalled PUT by its silence', async () => {
    const transfer = {
      method: 'single',
      url: 'https://storage.example.com/x',
      expires_at: new Date(Date.now() + 60_000).toISOString(),
      headers: {},
    };
    let puts = 0;
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith('/uploads')) return json(upload(transfer), 201);
      if (String(input).endsWith('/complete')) return json({ id: 'job' }, 202);
      puts += 1;
      if (puts > 1) return new Response('');
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }) as typeof globalThis.fetch;
    const rask = new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch, timeoutSeconds: 0.05 });
    await expect(rask.uploads.uploadFile(bytes, { filename: 'a.mp4' })).resolves.toMatchObject({ status: 202 });
    expect(puts).toBe(2);
  });

  it('stops on the caller signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('enough'));
    const { fetch, calls } = stubFetch([]);
    const rask = new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch });
    await expect(rask.uploads.uploadFile(bytes, { filename: 'a.mp4', signal: controller.signal })).rejects.toThrow(
      'enough',
    );
    expect(calls).toHaveLength(0);
  });
});
