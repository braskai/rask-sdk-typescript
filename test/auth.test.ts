import { afterEach, describe, expect, it, vi } from 'vitest';

import { RaskApiError, RaskAuthError, RaskClient } from '../src';
import { API, deferred, fakeFetch, json, TOKEN_URL } from './helpers';

const credits = { minutes: { total: 10, used: 1 }, video: { total: 5, used: 0 }, lipsync_free_minutes: { total: 0, used: 0 } };

const newClient = (fetch: typeof globalThis.fetch) =>
  new RaskClient({ clientId: 'my-client', clientSecret: 's3cr3t/+&=', fetch });

afterEach(() => {
  vi.useRealTimers();
});

describe('client credentials auth', () => {
  it('fetches a token with a client_secret_post form body and sends it as a bearer token', async () => {
    const mock = fakeFetch({ onApi: () => json(credits) });
    const rask = newClient(mock.fetch);

    await expect(rask.getCredits()).resolves.toEqual(credits);

    expect(mock.tokenCalls).toHaveLength(1);
    const [token] = mock.tokenCalls;
    expect(token!.method).toBe('POST');
    expect(token!.url.toString()).toBe(TOKEN_URL);
    expect(token!.headers.get('content-type')).toBe('application/x-www-form-urlencoded');
    expect(token!.headers.get('authorization')).toBeNull();
    const form = new URLSearchParams(await token!.request.text());
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'client_credentials',
      client_id: 'my-client',
      client_secret: 's3cr3t/+&=',
      scope: 'api/source api/input api/output api/limit',
    });

    expect(mock.apiCalls).toHaveLength(1);
    expect(mock.apiCalls[0]!.url.toString()).toBe(`${API}/v2/credits`);
    expect(mock.apiCalls[0]!.headers.get('authorization')).toBe('Bearer tok-1');
  });

  it('honours custom scopes and token URL', async () => {
    const tokenUrl = 'https://auth.example.test/oauth2/token';
    const seen: string[] = [];
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.url === tokenUrl) {
        seen.push(await request.text());
        return json({ access_token: 'custom', expires_in: 3600 });
      }
      return json(credits);
    }) as unknown as typeof globalThis.fetch;
    const rask = new RaskClient({ clientId: 'id', clientSecret: 'secret', tokenUrl, scopes: ['api/source'], fetch });

    await rask.getCredits();
    expect(new URLSearchParams(seen[0]).get('scope')).toBe('api/source');
  });

  it('caches the token until shortly before expires_in', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
    const mock = fakeFetch({
      onToken: () => json({ access_token: `tok-${mock.tokenCalls.length}`, expires_in: 600 }),
      onApi: () => json(credits),
    });
    const rask = newClient(mock.fetch);

    await rask.getCredits();
    await rask.getCredits();
    expect(mock.tokenCalls).toHaveLength(1);

    // 600 s lifetime, refreshed 60 s early.
    vi.setSystemTime(new Date('2026-01-01T00:08:59Z'));
    await rask.getCredits();
    expect(mock.tokenCalls).toHaveLength(1);

    vi.setSystemTime(new Date('2026-01-01T00:09:00Z'));
    await rask.getCredits();
    expect(mock.tokenCalls).toHaveLength(2);
    expect(mock.apiCalls.map((call) => call.headers.get('authorization'))).toEqual([
      'Bearer tok-1',
      'Bearer tok-1',
      'Bearer tok-1',
      'Bearer tok-2',
    ]);
  });

  it('shares one token request between concurrent calls', async () => {
    const gate = deferred<void>();
    const mock = fakeFetch({
      onToken: async () => {
        await gate.promise;
        return json({ access_token: 'shared', expires_in: 3600 });
      },
      onApi: () => json(credits),
    });
    const rask = newClient(mock.fetch);

    const calls = Promise.all([rask.getCredits(), rask.getCredits(), rask.getCredits(), rask.getAccessToken()]);
    await vi.waitFor(() => expect(mock.tokenCalls).toHaveLength(1));
    gate.resolve();
    const results = await calls;

    expect(results[3]).toBe('shared');
    expect(mock.tokenCalls).toHaveLength(1);
    expect(mock.apiCalls).toHaveLength(3);
    expect(new Set(mock.apiCalls.map((call) => call.headers.get('authorization')))).toEqual(new Set(['Bearer shared']));
  });

  it('refreshes the token once and retries the request after a 401', async () => {
    const mock = fakeFetch({
      onApi: (request) =>
        request.headers.get('authorization') === 'Bearer tok-1'
          ? json({ detail: 'Token expired' }, 401)
          : json(credits),
    });
    const rask = newClient(mock.fetch);

    await expect(rask.getCredits()).resolves.toEqual(credits);
    expect(mock.tokenCalls).toHaveLength(2);
    expect(mock.apiCalls.map((call) => call.headers.get('authorization'))).toEqual(['Bearer tok-1', 'Bearer tok-2']);
  });

  it('gives up after one retry when the API keeps answering 401', async () => {
    const mock = fakeFetch({ onApi: () => json({ detail: 'Not authenticated' }, 401) });
    const rask = newClient(mock.fetch);

    const error = await rask.getCredits().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RaskApiError);
    expect(error).not.toBeInstanceOf(RaskAuthError);
    expect((error as RaskApiError).status).toBe(401);
    expect((error as RaskApiError).detail).toBe('Not authenticated');
    expect(mock.apiCalls).toHaveLength(2);
    expect(mock.tokenCalls).toHaveLength(2);
  });

  it('refreshes only once when concurrent requests hit a 401 with the same token', async () => {
    const mock = fakeFetch({
      onApi: (request) =>
        request.headers.get('authorization') === 'Bearer tok-1' ? json({ detail: 'expired' }, 401) : json(credits),
    });
    const rask = newClient(mock.fetch);
    await rask.getAccessToken(); // tok-1 is cached

    await Promise.all([rask.getCredits(), rask.getCredits(), rask.getCredits()]);
    expect(mock.tokenCalls).toHaveLength(2);
    expect(mock.apiCalls).toHaveLength(6);
  });

  it('re-sends a multipart upload intact when retrying after a 401', async () => {
    const media = { id: 'm1' };
    const mock = fakeFetch({
      onApi: (request) =>
        request.headers.get('authorization') === 'Bearer tok-1' ? json({ detail: 'expired' }, 401) : json(media),
    });
    const rask = newClient(mock.fetch);

    await rask.createMediaFile({ data: new Blob(['frame-bytes'], { type: 'video/mp4' }), name: 'clip.mp4' });
    expect(mock.apiCalls).toHaveLength(2);
    const retried = await mock.apiCalls[1]!.request.formData();
    expect(retried.get('name')).toBe('clip.mp4');
    expect(await (retried.get('data') as Blob).text()).toBe('frame-bytes');
  });

  it('throws RaskAuthError when the token endpoint rejects the credentials', async () => {
    const mock = fakeFetch({
      onToken: () => json({ error: 'invalid_client' }, 400),
      onApi: () => json(credits),
    });
    const rask = newClient(mock.fetch);

    const error = await rask.getCredits().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RaskAuthError);
    expect(error).toBeInstanceOf(RaskApiError);
    expect((error as RaskAuthError).status).toBe(400);
    expect((error as RaskAuthError).body).toEqual({ error: 'invalid_client' });
    expect((error as RaskAuthError).message).toContain('invalid_client');
    expect(mock.apiCalls).toHaveLength(0);
    expect(mock.tokenCalls).toHaveLength(1);
  });

  it('getAccessToken returns the cached token and can force a refresh', async () => {
    const mock = fakeFetch({});
    const rask = newClient(mock.fetch);

    expect(await rask.getAccessToken()).toBe('tok-1');
    expect(await rask.getAccessToken()).toBe('tok-1');
    expect(await rask.getAccessToken({ forceRefresh: true })).toBe('tok-2');
    expect(mock.tokenCalls).toHaveLength(2);
  });
});

describe('access token auth', () => {
  it('uses a static token without calling the token endpoint and never retries', async () => {
    const mock = fakeFetch({ onApi: () => json({ detail: 'Not authenticated' }, 401) });
    const rask = new RaskClient({ accessToken: 'static-token', fetch: mock.fetch });

    await expect(rask.getCredits()).rejects.toMatchObject({ status: 401 });
    expect(mock.tokenCalls).toHaveLength(0);
    expect(mock.apiCalls).toHaveLength(1);
    expect(mock.apiCalls[0]!.headers.get('authorization')).toBe('Bearer static-token');
    expect(await rask.getAccessToken()).toBe('static-token');
  });

  it('calls a token getter before each request', async () => {
    let n = 0;
    const mock = fakeFetch({ onApi: () => json(credits) });
    const rask = new RaskClient({ accessToken: async () => `getter-${++n}`, fetch: mock.fetch });

    await rask.getCredits();
    await rask.getCredits();
    expect(mock.apiCalls.map((call) => call.headers.get('authorization'))).toEqual(['Bearer getter-1', 'Bearer getter-2']);
  });
});

describe('constructor validation', () => {
  it('requires client credentials or an access token', () => {
    expect(() => new RaskClient({} as never)).toThrow(TypeError);
    expect(() => new RaskClient({ clientId: 'id', clientSecret: '' })).toThrow(/clientSecret/);
    expect(() => new RaskClient({ accessToken: 't', clientId: 'id' } as never)).toThrow(/not both/);
  });
});
