import { vi } from 'vitest';

export const TOKEN_URL = 'https://rask-prod.auth.us-east-2.amazoncognito.com/oauth2/token';
export const API = 'https://api.rask.ai';

export const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

export interface Recorded {
  method: string;
  url: URL;
  headers: Headers;
  /** Unread copy of the request, for body assertions. */
  request: Request;
}

type Handler = (request: Request, url: URL) => Response | Promise<Response>;

/**
 * A fake `fetch` that routes token-endpoint calls to `onToken` and everything
 * else to `onApi`, recording every request. No network is touched.
 */
export const fakeFetch = (handlers: { onToken?: Handler; onApi?: Handler }) => {
  const tokenCalls: Recorded[] = [];
  const apiCalls: Recorded[] = [];
  let tokenCounter = 0;

  const defaultToken: Handler = () => {
    tokenCounter += 1;
    return json({ access_token: `tok-${tokenCounter}`, expires_in: 3600, token_type: 'Bearer' });
  };

  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const record: Recorded = {
      method: request.method,
      url,
      headers: request.headers,
      request: request.clone(),
    };
    if (request.url === TOKEN_URL) {
      tokenCalls.push(record);
      return (handlers.onToken ?? defaultToken)(request, url);
    }
    apiCalls.push(record);
    if (!handlers.onApi) throw new Error(`unexpected API call ${request.method} ${request.url}`);
    return handlers.onApi(request, url);
  });

  return { fetch: fetch as unknown as typeof globalThis.fetch, tokenCalls, apiCalls };
};

export const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
