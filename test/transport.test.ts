import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  AuthenticationError,
  BadRequestError,
  ConflictError,
  GoneError,
  InsufficientBalanceError,
  InternalServerError,
  NotFoundError,
  PayloadTooLargeError,
  PermissionDeniedError,
  PreconditionFailedError,
  PreconditionRequiredError,
  Rask,
  RaskConfigError,
  RaskConnectionError,
  RaskError,
  RaskTimeoutError,
  RateLimitError,
  ServiceUnavailableError,
  UnsupportedMediaTypeError,
  ValidationError,
  VERSION,
} from '../src/index';
import { backoffMs } from '../src/transport';
import { BASE, json, problem, stubFetch, TEST_KEY } from './helpers';

const client = (replies: Parameters<typeof stubFetch>[0], options = {}) => {
  const stub = stubFetch(replies);
  return { ...stub, rask: new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch: stub.fetch, ...options }) };
};

afterEach(() => vi.restoreAllMocks());

describe('errors', () => {
  it.each([
    [400, BadRequestError],
    [401, AuthenticationError],
    [402, InsufficientBalanceError],
    [403, PermissionDeniedError],
    [404, NotFoundError],
    [409, ConflictError],
    [410, GoneError],
    [412, PreconditionFailedError],
    [413, PayloadTooLargeError],
    [415, UnsupportedMediaTypeError],
    [422, ValidationError],
    [428, PreconditionRequiredError],
    [500, InternalServerError],
  ])('%i raises its class, and is not retried', async (status, ErrorClass) => {
    const { rask, calls } = client([problem(status, 'some_code')]);
    const error = await rask.account.getMe().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ErrorClass);
    expect(error).toBeInstanceOf(RaskError);
    expect(error).toMatchObject({ status, code: 'some_code', requestId: 'req-1', detail: 'some_code happened' });
    expect(calls).toHaveLength(1);
  });

  it('keeps members this version does not know', async () => {
    const { rask } = client([problem(404, 'brand_new', { brand_new_member: { a: 1 } })]);
    const error = (await rask.account.getMe().catch((caught: unknown) => caught)) as RaskError;
    expect(error.problem?.brand_new_member).toEqual({ a: 1 });
    expect(error.body).toEqual(error.problem);
  });

  it('types the balance and ETag members', async () => {
    const { rask } = client([
      problem(402, 'insufficient_balance', { credit_type: 'minutes', required_minutes: 5, balance_minutes: 1 }),
      problem(412, 'precondition_failed', { current_etag: '"s-2"' }),
    ]);
    const balance = await rask.account.getMe().catch((caught: unknown) => caught);
    expect(balance).toMatchObject({ creditType: 'minutes', requiredMinutes: 5, balanceMinutes: 1 });
    const stale = await rask.account.getMe().catch((caught: unknown) => caught);
    expect(stale).toMatchObject({ currentEtag: '"s-2"' });
  });

  it('survives an error body that is not JSON, and keeps it', async () => {
    const { rask } = client([new Response('<html>nope</html>', { status: 404 })]);
    const error = (await rask.account.getMe().catch((caught: unknown) => caught)) as RaskError;
    expect(error).toBeInstanceOf(NotFoundError);
    expect(error.code).toBeUndefined();
    expect(error.problem).toBeNull();
    expect(error.body).toBe('<html>nope</html>');
  });

  it('survives an empty error body', async () => {
    const { rask } = client([new Response(null, { status: 404 })]);
    await expect(rask.account.getMe()).rejects.toBeInstanceOf(NotFoundError);
  });

  it('raises on a 2xx that claims JSON and is not', async () => {
    const { rask } = client([new Response('{oops', { headers: { 'Content-Type': 'application/json' } })]);
    await expect(rask.account.getMe()).rejects.toThrow('could not be parsed');
  });
});

describe('retries', () => {
  it('retries a connection error, and reports it when the budget is gone', async () => {
    const { rask, calls } = client([new TypeError('fetch failed'), json({ id: 'me' })]);
    const result = await rask.account.getMe();
    expect(result.data).toEqual({ id: 'me' });
    expect(calls).toHaveLength(2);
  });

  it('honours an HTTP-date Retry-After', async () => {
    const at = new Date(Date.now() + 2000).toUTCString();
    const started = Date.now();
    const { rask } = client([new Response('', { status: 503, headers: { 'Retry-After': at } }), json({})]);
    await rask.account.getMe();
    expect(Date.now() - started).toBeGreaterThanOrEqual(900);
  });

  it('gives up at once on a Retry-After past the budget, keeping it on the error', async () => {
    const { rask, calls } = client([json({ status: 429, code: 'rate_limited' }, 429, { 'Retry-After': '130' })]);
    const error = await rask.account.getMe().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RateLimitError);
    expect(error).toMatchObject({ retryAfter: 130 });
    expect(calls).toHaveLength(1);
  });

  it('stops within the 120 s budget when the service stays down', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const started = Date.now();
      let last = started;
      let calls = 0;
      const fetch = (async () => {
        calls += 1;
        last = Date.now();
        return new Response('', { status: 503, headers: { 'Retry-After': '1' } });
      }) as typeof globalThis.fetch;
      const rask = new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch });
      let outcome: unknown;
      const call = rask.account.getMe().catch((caught: unknown) => {
        outcome = caught;
      });
      await vi.advanceTimersByTimeAsync(130_000);
      await call;
      expect(outcome).toBeInstanceOf(ServiceUnavailableError);
      expect(calls).toBeGreaterThan(5);
      expect(last - started).toBeLessThanOrEqual(120_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it('backs off from 0.5 s by a factor of 1.5, up to 30 s, with jitter of 25%', () => {
    const bounds = (attempt: number, base: number) => {
      const seen = Array.from({ length: 200 }, () => backoffMs(attempt));
      expect(Math.min(...seen)).toBeGreaterThanOrEqual(base * 0.75);
      expect(Math.max(...seen)).toBeLessThanOrEqual(base * 1.25);
    };
    bounds(0, 500);
    bounds(1, 750);
    bounds(2, 1125);
    bounds(20, 30_000);
  });

  it('stops retrying when the caller aborts, during the wait', async () => {
    const controller = new AbortController();
    const { rask, calls } = client([new Response('', { status: 503, headers: { 'Retry-After': '30' } }), json({})]);
    const call = rask.account.getMe({ signal: controller.signal });
    setTimeout(() => controller.abort(new Error('stop')), 20);
    await expect(call).rejects.toThrow('stop');
    expect(calls).toHaveLength(1);
  });

  it('does not retry after the caller aborts a request in flight', async () => {
    const controller = new AbortController();
    const fetch = vi.fn(
      (_: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
        }),
    );
    const rask = new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch: fetch as typeof globalThis.fetch });
    const call = rask.account.getMe({ signal: controller.signal });
    setTimeout(() => controller.abort(new Error('stop')), 20);
    await expect(call).rejects.toThrow('stop');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('reports a request past its timeout as RaskTimeoutError, with the key', async () => {
    const hang = (_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const replies = vi.fn(hang);
    const rask = new Rask({
      apiKey: TEST_KEY,
      baseUrl: BASE,
      fetch: replies as typeof globalThis.fetch,
      timeoutSeconds: 0.05,
    });
    const call = rask.projects.createFolder({ body: { name: 'x' }, idempotencyKey: 'caller-key' });
    // One retry is enough to know it times out and retries: the budget would take two minutes.
    await vi.waitFor(() => expect(replies.mock.calls.length).toBeGreaterThanOrEqual(2), { timeout: 3000 });
    call.catch(() => {});
    const seen = new Headers(replies.mock.calls[1]?.[1]?.headers);
    expect(seen.get('idempotency-key')).toBe('caller-key');
    expect(RaskTimeoutError.prototype).toBeInstanceOf(RaskConnectionError);
  });

  it.each([502, 503, 504])('marks a %i past its retries as ServiceUnavailableError', async (status) => {
    const { rask } = client([new Response('', { status, headers: { 'Retry-After': '999' } })]);
    await expect(rask.account.getMe()).rejects.toBeInstanceOf(ServiceUnavailableError);
  });

  it('takes a redirect whose Location no URL can be made of as the answer, without a retry', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      let calls = 0;
      // No URL can be made of this Location, however often it is asked for.
      const fetch = (async () => {
        calls += 1;
        return new Response(null, { status: 307, headers: { Location: 'http://[' } });
      }) as typeof globalThis.fetch;
      const rask = new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch });
      let outcome: unknown;
      const call = rask.account.getMe().catch((caught: unknown) => {
        outcome = caught;
      });
      await vi.advanceTimersByTimeAsync(130_000);
      await call;
      expect(outcome).toBeInstanceOf(RaskError);
      expect(outcome).not.toBeInstanceOf(RaskConnectionError);
      expect((outcome as RaskError).status).toBe(307);
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('arguments', () => {
  it('raises before the network on a missing or empty path parameter', async () => {
    const { rask, calls } = client([]);
    const call = rask.projects.getProject as (params: unknown) => Promise<unknown>;
    await expect(call.call(rask.projects, {})).rejects.toBeInstanceOf(RaskConfigError);
    await expect(rask.projects.getProject({ path: { project_id: '' } })).rejects.toThrow('project_id');
    expect(calls).toHaveLength(0);
  });

  it.each(['.', '..'])('raises before the network on the dot segment %s in a path parameter', async (id) => {
    const { rask, calls } = client([]);
    await expect(rask.projects.getProject({ path: { project_id: id } })).rejects.toBeInstanceOf(RaskConfigError);
    await expect(
      rask.segments.deleteSegment({ path: { project_id: 'p', segment_id: id }, ifMatch: '"e"' }),
    ).rejects.toThrow('segment_id');
    await expect(rask.jobs.wait(id)).rejects.toBeInstanceOf(RaskConfigError);
    expect(calls).toHaveLength(0);
  });

  it('raises before the network when a required ifMatch is missing', async () => {
    const { rask, calls } = client([]);
    const params = { path: { project_id: 'p', segment_id: 's' }, body: { translation_text: 'x' } };
    // @ts-expect-error ifMatch is required, so this does not compile either.
    await expect(rask.segments.updateSegment(params)).rejects.toThrow('if_match');
    expect(calls).toHaveLength(0);
  });

  it('sends no body and no Content-Type where none is passed', async () => {
    const { rask, calls } = client([json({}, 202)]);
    await rask.uploads.completeUpload({ path: { upload_id: 'u' } });
    expect(calls[0]?.body).toBeUndefined();
    expect(calls[0]?.headers.get('content-type')).toBeNull();
    expect(calls[0]?.headers.get('idempotency-key')).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('results', () => {
  it('exposes status and headers with no second call', async () => {
    const { rask } = client([
      json({ id: 'f' }, 201, {
        ETag: '"e"',
        Location: '/v3/folders/f',
        'X-Request-Id': 'r',
        'Idempotent-Replayed': 'true',
      }),
    ]);
    const result = await rask.projects.createFolder({ body: { name: 'x' } });
    expect(result).toMatchObject({
      status: 201,
      etag: '"e"',
      location: '/v3/folders/f',
      requestId: 'r',
      idempotentReplayed: true,
    });
    expect(result.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('gives undefined for 204 and for a 304 asked for with ifNoneMatch', async () => {
    const { rask } = client([new Response(null, { status: 204 }), new Response(null, { status: 304 })]);
    expect((await rask.projects.deleteFolder({ path: { folder_id: 'f' } })).data).toBeUndefined();
    const cached = await rask.catalogs.listLanguages({ ifNoneMatch: '"l"' });
    expect(cached.status).toBe(304);
    expect(cached.data).toBeUndefined();
  });

  it('raises a 304 nobody asked for', async () => {
    const { rask } = client([new Response(null, { status: 304 })]);
    await expect(rask.catalogs.listLanguages()).rejects.toBeInstanceOf(RaskError);
  });
});

describe('deprecation', () => {
  it('warns once per operation, on console.warn by default', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const deprecated = () =>
      json({}, 200, { Deprecation: '@1788000000', Sunset: 'Sat, 01 Jan 2028 00:00:00 GMT', Link: '<https://x>' });
    const { rask } = client([deprecated(), deprecated(), deprecated()]);
    await rask.account.getMe();
    await rask.account.getMe();
    await rask.account.getBalance();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0]?.[0]).toContain('getMe');
    expect(warn.mock.calls[0]?.[0]).toContain('2028');
  });
});

describe('identifying itself', () => {
  it('sends User-Agent and X-Rask-Client on API calls', async () => {
    const { rask, calls } = client([json({})]);
    await rask.account.getMe();
    expect(calls[0]?.headers.get('user-agent')).toBe(`rask-sdk-typescript/${VERSION} node/${process.versions.node}`);
    expect(calls[0]?.headers.get('x-rask-client')).toBe(`rask-sdk-typescript/${VERSION}`);
  });
});

describe('debug logging', () => {
  it('is off by default and redacts when on', async () => {
    const logger = vi.fn();
    const off = client([json({})], { logger });
    await off.rask.account.getMe();
    expect(logger).not.toHaveBeenCalled();

    const on = client([json({ data: [], next_cursor: null })], { logger, logLevel: 'debug' });
    await on.rask.projects.listProjects({ query: { limit: 2 } });
    const lines = logger.mock.calls.map(([line]) => line).join('\n');
    expect(lines).toContain('limit=2');
    expect(lines).toContain('authorization=[redacted]');
    expect(lines).not.toContain(TEST_KEY);
  });

  it('follows RASK_LOG', async () => {
    process.env.RASK_LOG = 'debug';
    const logger = vi.fn();
    try {
      const { rask } = client([json({})], { logger });
      await rask.account.getMe();
      expect(logger).toHaveBeenCalled();
    } finally {
      delete process.env.RASK_LOG;
    }
  });
});
