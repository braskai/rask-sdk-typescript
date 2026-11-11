import { afterAll, beforeAll } from 'vitest';
import { startHarness } from './acceptance/harness.mjs';
import { controlClient } from './acceptance/runner.mjs';

export interface HarnessHandle {
  baseUrl: string;
  apiKey: string;
  otherUrl: string;
  control: ReturnType<typeof controlClient>;
  requests(): Promise<RecordedRequest[]>;
}

export interface RecordedRequest {
  listener: string;
  operationId: string;
  method: string;
  path: string;
  raw_query: string;
  url: string;
  headers: Record<string, string>;
  violations: unknown[];
  body_bytes: number;
  body_sha256: string;
  response: { status: number; headers: Record<string, string>; self_check: unknown[] };
}

/** One harness per test file. Reset it before each test that scripts it. */
export function useHarness(extra: string[] = []): HarnessHandle {
  const handle = {} as HarnessHandle;
  let stop = () => {};
  beforeAll(async () => {
    const harness = await startHarness(extra);
    stop = harness.stop;
    const control = controlClient(harness.control);
    Object.assign(handle, {
      baseUrl: harness.baseUrl,
      apiKey: harness.apiKey,
      otherUrl: harness.otherUrl,
      control,
      requests: async () => (await control.get('/requests')).requests,
    });
  });
  afterAll(() => stop());
  return handle;
}

export const TEST_KEY = 'raskai_test_key_NotARealCredential';
export const BASE = 'http://127.0.0.1:9/gateway/v3';

export interface StubCall {
  url: string;
  method: string;
  headers: Headers;
  body: string | undefined;
}

type Reply = Response | Error | ((call: StubCall) => Response | Promise<Response>);

/** A fetch that answers from a list and records what it was asked. */
export function stubFetch(replies: Reply[]): { fetch: typeof globalThis.fetch; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const body = typeof init.body === 'string' ? init.body : undefined;
    const call = { url: String(input), method: init.method ?? 'GET', headers: new Headers(init.headers), body };
    calls.push(call);
    const reply = replies.shift();
    if (reply === undefined) throw new Error(`No reply left for ${call.method} ${call.url}`);
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply(call) : reply;
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

export const json = (body: unknown, status = 200, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } });

export const problem = (status: number, code: string, extra: Record<string, unknown> = {}): Response =>
  json({ status, code, title: code, detail: `${code} happened`, ...extra }, status, {
    'Content-Type': 'application/problem+json',
    'X-Request-Id': 'req-1',
  });
