import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_BASE_URL, Rask, RaskConfigError } from '../src/index';
import { BASE, json, stubFetch, TEST_KEY } from './helpers';

const ENV = ['RASK_API_KEY', 'RASK_BASE_URL', 'RASK_LOG'];

beforeEach(() => {
  for (const name of ENV) delete process.env[name];
});
afterEach(() => {
  for (const name of ENV) delete process.env[name];
});

describe('resolving the base URL', () => {
  it('defaults to the production API without sending anything', () => {
    expect(new Rask({ apiKey: TEST_KEY }).config.baseUrl).toBe('https://api.rask.ai/v3');
    expect(DEFAULT_BASE_URL).toBe('https://api.rask.ai/v3');
  });

  it.each([
    ['https://gw.example.com/rask/v3', 'https://gw.example.com/rask/v3'],
    ['https://gw.example.com/rask/v3/', 'https://gw.example.com/rask/v3'],
    ['https://gw.example.com/rask/v3///', 'https://gw.example.com/rask/v3'],
    ['http://127.0.0.1:8080', 'http://127.0.0.1:8080'],
    ['HTTPS://GW.Example.com/Rask/v3', 'https://gw.example.com/Rask/v3'],
  ])('reads %s as %s, by argument and from the environment', (raw, expected) => {
    expect(new Rask({ apiKey: TEST_KEY, baseUrl: raw }).config.baseUrl).toBe(expected);
    process.env.RASK_BASE_URL = raw;
    expect(new Rask({ apiKey: TEST_KEY }).config.baseUrl).toBe(expected);
  });

  it('takes the argument over the environment, and treats an empty variable as unset', () => {
    process.env.RASK_BASE_URL = 'https://env.example.com/v3';
    expect(new Rask({ apiKey: TEST_KEY, baseUrl: 'https://arg.example.com/v3' }).config.baseUrl).toBe(
      'https://arg.example.com/v3',
    );
    process.env.RASK_BASE_URL = '';
    expect(new Rask({ apiKey: TEST_KEY }).config.baseUrl).toBe(DEFAULT_BASE_URL);
  });

  it.each([
    ['not a url', 'not a URL'],
    ['ftp://example.com/v3', 'http or https'],
    ['https://user:pw@example.com/v3', 'credentials'],
    ['https://example.com/v3?x=1', 'query'],
    ['https://example.com/v3#x', 'query'],
  ])('refuses %s', (raw, message) => {
    expect(() => new Rask({ apiKey: TEST_KEY, baseUrl: raw })).toThrow(RaskConfigError);
    expect(() => new Rask({ apiKey: TEST_KEY, baseUrl: raw })).toThrow(message);
  });

  it('puts every path after the prefix, also where URL resolution would drop it', async () => {
    const { fetch, calls } = stubFetch([json({}), json({}, 200), json({ data: [], next_cursor: null })]);
    const rask = new Rask({ apiKey: TEST_KEY, baseUrl: `${BASE}/`, fetch });
    await rask.account.getMe();
    await rask.projects.getProject({ path: { project_id: 'p/1' } });
    await rask.projects.listProjects({ query: { ids: ['a', 'b'], limit: 5 } });
    expect(calls.map((call) => call.url)).toEqual([
      `${BASE}/me`,
      `${BASE}/projects/p%2F1`,
      `${BASE}/projects?ids=a,b&limit=5`,
    ]);
  });
});

describe('where the key goes', () => {
  const redirect = (location: string, status = 307) => new Response(null, { status, headers: { Location: location } });

  it('sends it to the base URL', async () => {
    const { fetch, calls } = stubFetch([json({})]);
    await new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch }).account.getMe();
    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_KEY}`);
  });

  it('keeps it on a redirect under the base URL', async () => {
    const { fetch, calls } = stubFetch([redirect('/gateway/v3/me2'), json({})]);
    await new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch }).account.getMe();
    expect(calls.map((call) => call.url)).toEqual([`${BASE}/me`, `${BASE}/me2`]);
    expect(calls[1]?.headers.get('authorization')).toBe(`Bearer ${TEST_KEY}`);
  });

  it.each([
    ['another host', 'https://attacker.example.com/gateway/v3/me'],
    ['another port', 'http://127.0.0.1:10/gateway/v3/me'],
    ['another scheme', 'https://127.0.0.1:9/gateway/v3/me'],
    ['the same host outside the prefix', 'http://127.0.0.1:9/other-tenant/me'],
    ['a prefix that only starts alike', 'http://127.0.0.1:9/gateway/v3-evil/me'],
  ])('drops it on a redirect to %s', async (_, location) => {
    const { fetch, calls } = stubFetch([redirect(location), json({})]);
    await new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch }).account.getMe();
    expect(calls[0]?.headers.get('authorization')).toBe(`Bearer ${TEST_KEY}`);
    expect(calls[1]?.url).toBe(location);
    expect(calls[1]?.headers.get('authorization')).toBeNull();
  });

  it('does not take it back to a later hop of a chain once it has left, unless the hop is the API itself', async () => {
    const { fetch, calls } = stubFetch([redirect('https://other.example.com/x'), redirect(`${BASE}/me3`), json({})]);
    await new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch }).account.getMe();
    expect(calls[1]?.headers.get('authorization')).toBeNull();
    expect(calls[2]?.headers.get('authorization')).toBe(`Bearer ${TEST_KEY}`);
  });

  it('turns a POST into a GET on 303, without the body or the key headers', async () => {
    const { fetch, calls } = stubFetch([redirect(`${BASE}/folders/f1`, 303), json({})]);
    await new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch }).projects.createFolder({ body: { name: 'x' } });
    expect(calls[1]?.method).toBe('GET');
    expect(calls[1]?.body).toBeUndefined();
    expect(calls[1]?.headers.get('idempotency-key')).toBeNull();
    expect(calls[1]?.headers.get('content-type')).toBeNull();
  });

  it('repeats a POST with its body and key on 307', async () => {
    const { fetch, calls } = stubFetch([redirect('https://other.example.com/folders'), json({})]);
    await new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch }).projects.createFolder({ body: { name: 'x' } });
    expect(calls[1]?.method).toBe('POST');
    expect(calls[1]?.body).toBe('{"name":"x"}');
    expect(calls[1]?.headers.get('idempotency-key')).toBe(calls[0]?.headers.get('idempotency-key'));
    expect(calls[1]?.headers.get('authorization')).toBeNull();
  });

  it('stops following after 5 redirects and raises', async () => {
    const replies = Array.from({ length: 6 }, (_, index) => redirect(`${BASE}/hop${index}`));
    const { fetch, calls } = stubFetch(replies);
    await expect(new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch }).account.getMe()).rejects.toMatchObject({
      status: 307,
    });
    expect(calls).toHaveLength(6);
  });

  it('does not show it in the client, its logs or its errors', async () => {
    const lines: string[] = [];
    const { fetch } = stubFetch([json({ code: 'invalid_token', status: 401 }, 401)]);
    const rask = new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch, logLevel: 'debug', logger: (l) => lines.push(l) });
    const error = await rask.account.getMe().catch((caught: unknown) => caught as Error);
    const shown = [
      String(rask),
      JSON.stringify(rask),
      lines.join('\n'),
      String(error),
      JSON.stringify(error),
      (error as Error).stack,
    ];
    expect(lines.join('\n')).toContain('authorization=[redacted]');
    for (const text of shown) expect(text).not.toContain(TEST_KEY);
  });
});

describe('the key', () => {
  it('comes from the argument, then RASK_API_KEY, and its absence names the variable', () => {
    expect(() => new Rask({ baseUrl: BASE })).toThrow('RASK_API_KEY');
    process.env.RASK_API_KEY = '';
    expect(() => new Rask({ baseUrl: BASE })).toThrow('RASK_API_KEY');
    process.env.RASK_API_KEY = TEST_KEY;
    expect(new Rask({ baseUrl: BASE }).config.baseUrl).toBe(BASE);
  });

  it.each([
    ['a control character', '\n'],
    // A key pasted from a page may end with one. No runtime puts it in a header, so no call could succeed.
    ['a zero-width space', '\u200b'],
    ['a letter outside ASCII', '\u00e9'],
  ])('refuses %s without echoing the key', (_, character) => {
    expect(() => new Rask({ apiKey: `${TEST_KEY}${character}`, baseUrl: BASE })).toThrow(RaskConfigError);
    try {
      new Rask({ apiKey: `${TEST_KEY}${character}`, baseUrl: BASE });
    } catch (error) {
      expect(String(error)).not.toContain(TEST_KEY);
    }
  });
});

describe('in a browser', () => {
  const browser = globalThis as unknown as { window?: unknown; document?: unknown };
  afterEach(() => {
    delete browser.window;
    delete browser.document;
  });

  it('refuses to construct, naming dangerouslyAllowBrowser, unless it is set', () => {
    browser.window = {};
    browser.document = {};
    expect(() => new Rask({ apiKey: TEST_KEY, baseUrl: BASE })).toThrow('dangerouslyAllowBrowser');
    expect(new Rask({ apiKey: TEST_KEY, baseUrl: BASE, dangerouslyAllowBrowser: true }).config.baseUrl).toBe(BASE);
  });
});
