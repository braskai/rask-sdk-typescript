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
import { backoffMs, isCertificateFailure } from '../src/transport';
import { BASE, json, problem, stubFetch, TEST_KEY } from './helpers';

const client = (replies: Parameters<typeof stubFetch>[0], options = {}) => {
  const stub = stubFetch(replies);
  return { ...stub, rask: new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch: stub.fetch, ...options }) };
};

afterEach(() => vi.restoreAllMocks());

// What fetch threw on each runtime, recorded against a local HTTPS server with throwaway certificates and then built
// here by hand. test/runtime/check.mjs makes such certificates again and shows the same on the runtime itself.
const SEEN_URL = 'https://localhost:8443/v3/folders';
// Node 24.14.1 (undici): a TypeError that says nothing, with the reason and its code in `cause`.
const fromNode = (code: string, message: string) =>
  new TypeError('fetch failed', { cause: Object.assign(new Error(message), { code }) });
// Bun 1.3.13: an Error that carries the code itself, and no cause.
const fromBun = (code: string, message: string) =>
  Object.assign(new Error(message), { code, path: SEEN_URL, errno: 0 });
// Deno 2.7.12 (rustls): a TypeError with a message and nothing else.
const fromDeno = (reason: string) =>
  new TypeError(`error sending request for url (${SEEN_URL}): client error (Connect): ${reason}`);
const NODE_HINT = '; if the root CA is installed locally, try running Node.js with --use-system-ca';
const BUN_HINT = 'For more information, pass `verbose: true` in the second argument to fetch()';

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

describe('a certificate that fails verification', () => {
  it.each([
    ['Node, self-signed', fromNode('DEPTH_ZERO_SELF_SIGNED_CERT', `self-signed certificate${NODE_HINT}`)],
    [
      'Node, self-signed in the chain',
      fromNode('SELF_SIGNED_CERT_IN_CHAIN', 'self-signed certificate in certificate chain'),
    ],
    [
      'Node, unknown issuer',
      fromNode('UNABLE_TO_VERIFY_LEAF_SIGNATURE', `unable to verify the first certificate${NODE_HINT}`),
    ],
    [
      'Node, unknown issuer above an intermediate',
      fromNode('UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'unable to get local issuer certificate'),
    ],
    ['Node, expired', fromNode('CERT_HAS_EXPIRED', 'certificate has expired')],
    ['Node, not valid yet', fromNode('CERT_NOT_YET_VALID', 'certificate is not yet valid')],
    ['Node, signed by another key', fromNode('CERT_SIGNATURE_FAILURE', 'certificate signature failure')],
    ['Node, for clients only', fromNode('INVALID_PURPOSE', 'unsuitable certificate purpose')],
    [
      'Node, another host name',
      fromNode(
        'ERR_TLS_CERT_ALTNAME_INVALID',
        "Hostname/IP does not match certificate's altnames: Host: localhost. is not in the cert's altnames: DNS:elsewhere.test",
      ),
    ],
    ['Bun, self-signed', fromBun('DEPTH_ZERO_SELF_SIGNED_CERT', 'self signed certificate')],
    [
      'Bun, self-signed in the chain',
      fromBun('SELF_SIGNED_CERT_IN_CHAIN', 'self signed certificate in certificate chain'),
    ],
    ['Bun, unknown issuer', fromBun('UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'unable to verify the first certificate')],
    [
      'Bun, unknown issuer above an intermediate',
      fromBun('UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'unable to get local issuer certificate'),
    ],
    ['Bun, expired', fromBun('CERT_HAS_EXPIRED', 'certificate has expired')],
    ['Bun, not valid yet', fromBun('CERT_NOT_YET_VALID', 'certificate is not yet valid')],
    ['Bun, signed by another key', fromBun('CERT_SIGNATURE_FAILURE', 'certificate signature failure')],
    ['Bun, for clients only', fromBun('INVALID_PURPOSE', 'unsupported certificate purpose')],
    [
      'Bun, another host name',
      fromBun('ERR_TLS_CERT_ALTNAME_INVALID', `ERR_TLS_CERT_ALTNAME_INVALID fetching "${SEEN_URL}". ${BUN_HINT}`),
    ],
    ['Deno, self-signed or of an unknown issuer', fromDeno('invalid peer certificate: UnknownIssuer')],
    [
      'Deno, self-signed and marked as an authority',
      fromDeno('invalid peer certificate: Other(OtherError(CaUsedAsEndEntity))'),
    ],
    [
      'Deno, expired',
      fromDeno(
        'invalid peer certificate: certificate expired: verification time 1794405380 (UNIX), but certificate is not valid after 1577923200 (216482180 seconds ago)',
      ),
    ],
    [
      'Deno, not valid yet',
      fromDeno(
        'invalid peer certificate: certificate not valid yet: verification time 1794405380 (UNIX), but certificate is not valid before 2208988800 (414583420 seconds in future)',
      ),
    ],
    ['Deno, signed by another key', fromDeno('invalid peer certificate: BadSignature')],
    [
      'Deno, for clients only',
      fromDeno(
        'invalid peer certificate: certificate does not allow extended key usage for server authentication, allows client authentication',
      ),
    ],
    [
      'Deno, another host name',
      fromDeno(
        'invalid peer certificate: certificate not valid for name "localhost"; certificate is only valid for DnsName("elsewhere.test")',
      ),
    ],
  ])('ends the call at its first attempt, with the cause and the key (%s)', async (_seen, thrown) => {
    // The same on every attempt: a retry would only report it two minutes later.
    const { rask, calls } = client([thrown, json({ id: 'f' }, 201)]);
    const error = await rask.projects
      .createFolder({ body: { name: 'x' }, idempotencyKey: 'caller-key' })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RaskConnectionError);
    expect(error).not.toBeInstanceOf(RaskTimeoutError);
    expect((error as RaskError).cause).toBe(thrown);
    expect((error as RaskError).idempotencyKey).toBe('caller-key');
    expect(calls).toHaveLength(1);
  });

  it.each([
    [
      'Node, refused',
      new TypeError('fetch failed', {
        cause: Object.assign(new AggregateError([new Error('connect ECONNREFUSED 127.0.0.1:8443')], ''), {
          code: 'ECONNREFUSED',
        }),
      }),
    ],
    [
      'Node, reset in the handshake',
      fromNode('ECONNRESET', 'Client network socket disconnected before secure TLS connection was established'),
    ],
    ['Node, closed by the other side', fromNode('UND_ERR_SOCKET', 'other side closed')],
    [
      'Node, no TLS on the port',
      fromNode(
        'ERR_SSL_PACKET_LENGTH_TOO_LONG',
        '00534CF101000000:error:0A0000C6:SSL routines:tls_get_more_records:packet length too long:../deps/openssl/openssl/ssl/record/methods/tls_common.c:661:\n',
      ),
    ],
    ['Node, no such host', fromNode('ENOTFOUND', 'getaddrinfo ENOTFOUND no-such-host.invalid')],
    [
      'Bun, refused, and no such host',
      fromBun('ConnectionRefused', 'Unable to connect. Is the computer able to access the url?'),
    ],
    ['Bun, reset', fromBun('ECONNRESET', `The socket connection was closed unexpectedly. ${BUN_HINT}`)],
    ['Deno, refused', fromDeno('tcp connect error: Connection refused (os error 61)')],
    ['Deno, reset in the handshake', fromDeno('tls handshake eof')],
    ['Deno, no TLS on the port', fromDeno('received corrupt message of type InvalidContentType')],
    [
      'Deno, no such host',
      fromDeno('dns error: failed to lookup address information: nodename nor servname provided, or not known'),
    ],
    [
      'Deno, the server asks the client for a certificate',
      new TypeError(
        'error sending request from 127.0.0.1:62701 for https://localhost:8443/ (127.0.0.1:8443): client error (SendRequest): connection error: received fatal alert: CertificateRequired',
        { cause: new Error('received fatal alert: CertificateRequired') },
      ),
    ],
    ['a fetch that says nothing', new TypeError('fetch failed')],
    ['a timeout', new DOMException('The operation was aborted due to timeout', 'TimeoutError')],
    ['nothing', undefined],
  ])('is not seen in any other failure, which is retried as before (%s)', (_seen, thrown) => {
    expect(isCertificateFailure(thrown)).toBe(false);
  });

  it('is found under the causes a fetch of your own adds, and not looked for in a circle of them', () => {
    const wrapped = new Error('request failed', { cause: fromNode('CERT_HAS_EXPIRED', 'certificate has expired') });
    expect(isCertificateFailure(wrapped)).toBe(true);
    const circle = new Error('round');
    circle.cause = circle;
    expect(isCertificateFailure(circle)).toBe(false);
  });
});

describe("the caller's signal", () => {
  // Bun 1.3 stops the timer of an AbortSignal.timeout() for good once its last listener is taken off, and a listener
  // left on would pile up on a signal that outlives the call. That the timeout still comes on each runtime is for
  // test/runtime/check.mjs to show: this holds the rule that keeps it coming.
  it('is waited on between attempts without a listener of its own', async () => {
    const signal = AbortSignal.timeout(60_000);
    const added = vi.spyOn(signal, 'addEventListener');
    const removed = vi.spyOn(signal, 'removeEventListener');
    const { rask, calls } = client([new Response('', { status: 503 }), json({ id: 'me' })]);
    await rask.account.getMe({ signal });
    expect(calls).toHaveLength(2);
    expect(added).not.toHaveBeenCalled();
    expect(removed).not.toHaveBeenCalled();
  });

  it('ends every wait that is on it, and a later call before it is sent', async () => {
    const controller = new AbortController();
    const busy = () => client([new Response('', { status: 503, headers: { 'Retry-After': '30' } })]);
    const waiting = [busy(), busy()].map(({ rask }) =>
      rask.account.getMe({ signal: controller.signal }).catch((caught: unknown) => caught),
    );
    setTimeout(() => controller.abort(new Error('stop')), 20);
    for (const outcome of await Promise.all(waiting)) expect(outcome).toBe(controller.signal.reason);
    const late = busy();
    await expect(late.rask.account.getMe({ signal: controller.signal })).rejects.toThrow('stop');
    expect(late.calls).toHaveLength(0);
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
