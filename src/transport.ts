import {
  errorFromResponse,
  RaskConfigError,
  RaskConnectionError,
  RaskError,
  RaskTimeoutError,
  retryAfterSeconds,
} from './errors';
import { createClient, createConfig } from './generated/client';
import { type ListBody, Page, PagePromise } from './pagination';

/** What the generator knows about an operation (see scripts/generate-resources.mjs). */
export interface OperationMeta {
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly pathParams: readonly string[];
  readonly idempotencyKey: 'required' | 'optional' | 'none';
  readonly ifMatch: 'required' | 'optional' | 'none';
  readonly ifNoneMatch: boolean;
}

/** Per-call settings, on every operation. */
export interface CallOptions {
  /** Cancels the call, its retries and their waits. */
  signal?: AbortSignal;
  /** Overrides the client's per-request timeout for this call. */
  timeoutSeconds?: number;
}

interface OperationParams extends CallOptions {
  path?: Record<string, unknown>;
  query?: Record<string, unknown>;
  body?: unknown;
  idempotencyKey?: string;
  ifMatch?: string;
  ifNoneMatch?: string;
}

/** A result: the body plus what only the response says, with no second call. */
export interface RaskResponse<T> {
  /** The parsed body, unknown fields and values included. Undefined on 204 and 304. */
  readonly data: T;
  readonly status: number;
  readonly headers: Headers;
  readonly requestId: string | undefined;
  /** The key this call sent, generated or yours. */
  readonly idempotencyKey: string | undefined;
  readonly etag: string | undefined;
  readonly location: string | undefined;
  /** True when the server answered from a stored response for the same key. */
  readonly idempotentReplayed: boolean;
}

export interface DeprecationNotice {
  operationId: string;
  deprecation: string;
  sunset: string | undefined;
  link: string | undefined;
  message: string;
}

export interface TransportConfig {
  apiKey: string;
  baseUrl: string;
  timeoutSeconds: number;
  userAgent: string;
  clientId: string;
  debug: boolean;
  logger: (line: string) => void;
  onDeprecation: (notice: DeprecationNotice) => void;
  fetch: typeof globalThis.fetch | undefined;
}

type LowLevelCall = (options: never) => Promise<unknown>;
interface LowLevelResult {
  data?: unknown;
  error?: unknown;
  response?: Response;
}

const RETRY_STATUSES = new Set([429, 502, 503, 504]);
const RETRY_BUDGET_MS = 120_000;
const BACKOFF_START_MS = 500;
const BACKOFF_MAX_MS = 30_000;
const BACKOFF_FACTOR = 1.5;
const KEY_IN_USE_RETRIES = 3;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const NO_BODY_STATUSES = new Set([204, 205, 304]);
const SECRET_QUERY = /signature|credential|token|secret|sig$|key$/i;

/** Exponential backoff with jitter of +/- 25%. */
export const backoffMs = (attempt: number): number =>
  Math.min(BACKOFF_START_MS * BACKOFF_FACTOR ** attempt, BACKOFF_MAX_MS) * (0.75 + Math.random() / 2);

export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

/**
 * One logical API call: the Authorization header, redirects, timeouts, retries, the idempotency key, errors and debug
 * logging. The generated functions build the requests; this class is the fetch they use.
 */
export class Transport {
  readonly baseUrl: string;
  readonly timeoutSeconds: number;
  #apiKey: string;
  #base: URL;
  #config: TransportConfig;
  #client: unknown;
  #warned = new Set<string>();

  constructor(config: TransportConfig) {
    this.#apiKey = config.apiKey;
    this.#config = config;
    this.baseUrl = config.baseUrl;
    this.#base = new URL(config.baseUrl);
    this.timeoutSeconds = config.timeoutSeconds;
    const client = createClient(
      createConfig({
        baseUrl: config.baseUrl,
        headers: { Accept: 'application/json', 'User-Agent': config.userAgent, 'X-Rask-Client': config.clientId },
        querySerializer: { array: { explode: false, style: 'form' } },
      }),
    );
    // The generated functions pass their whole options on to `new Request(url, options)`, and Deno's Request takes a
    // `client` option of its own: "Argument 2 `client` must be a Deno.HttpClient". So `client` stops here.
    const drop =
      (method: (options: never) => unknown) =>
      ({ client: _client, ...options }: Record<string, unknown>) =>
        method(options as never);
    this.#client = {
      get: drop(client.get as never),
      post: drop(client.post as never),
      put: drop(client.put as never),
      patch: drop(client.patch as never),
      delete: drop(client.delete as never),
    };
  }

  /** Sends through the configured fetch, or the global one as it is now, so a test can stub it. */
  fetch(url: string, init: RequestInit): Promise<Response> {
    const fetchImpl = this.#config.fetch ?? globalThis.fetch;
    // Called detached: a browser's fetch throws "Illegal invocation" with this as its receiver.
    return fetchImpl(url, init);
  }

  /** True when a custom fetch was configured. */
  get hasCustomFetch(): boolean {
    return this.#config.fetch !== undefined;
  }

  log(line: string): void {
    if (this.#config.debug) this.#config.logger(`[rask] ${line}`);
  }

  /** Only a URL under the base URL keeps its query in the logs: a presigned URL carries its signature there. */
  redactUrl(raw: string): string {
    const url = new URL(raw);
    if (!url.search) return raw;
    if (!this.#isUnderBase(url)) return `${url.origin}${url.pathname}?[redacted]`;
    for (const name of [...url.searchParams.keys()]) {
      if (SECRET_QUERY.test(name)) url.searchParams.set(name, '[redacted]');
    }
    return url.toString();
  }

  #isUnderBase(url: URL): boolean {
    if (url.origin !== this.#base.origin) return false;
    const prefix = this.#base.pathname.replace(/\/+$/, '');
    return url.pathname === prefix || url.pathname.startsWith(`${prefix}/`);
  }

  /**
   * A request and its redirects. The key travels only to the base URL's origin, under its path. `failed` names what a
   * failure of the network is raised as. Anything else thrown here is raised as it is: no retry would mend it.
   */
  async #send(
    method: string,
    url: string,
    headers: Headers,
    body: string | undefined,
    signal: AbortSignal,
    failed: (cause: unknown) => unknown,
    hop = 0,
  ): Promise<Response> {
    const target = new URL(url);
    const outgoing = new Headers(headers);
    if (this.#isUnderBase(target)) outgoing.set('Authorization', `Bearer ${this.#apiKey}`);
    else outgoing.delete('Authorization');

    const started = Date.now();
    this.log(
      `> ${method} ${this.redactUrl(url)} authorization=${outgoing.has('Authorization') ? '[redacted]' : 'none'}`,
    );
    let fetched: Response;
    let bytes: ArrayBuffer;
    try {
      fetched = await this.fetch(url, {
        method,
        headers: outgoing,
        body: body ?? null,
        redirect: 'manual',
        signal,
      });
      // Read here, so a connection lost in mid-body is one more connection error and the timeout covers the body.
      bytes = await fetched.arrayBuffer();
    } catch (cause) {
      throw failed(cause);
    }
    const requestId = fetched.headers.get('x-request-id') ?? '-';
    this.log(`< ${fetched.status} ${method} ${this.redactUrl(url)} ${Date.now() - started}ms request_id=${requestId}`);

    const location = fetched.headers.get('location');
    // A Location no URL can be made of is not followed, like one that is not HTTP: the redirect is the answer.
    if (REDIRECT_STATUSES.has(fetched.status) && location && hop < MAX_REDIRECTS && URL.canParse(location, url)) {
      const next = new URL(location, url);
      if (next.protocol === 'http:' || next.protocol === 'https:') {
        // The fetch standard's rule: 303 turns anything but GET and HEAD into GET, and 301 or 302 a POST.
        const toGet =
          (fetched.status === 303 && method !== 'GET' && method !== 'HEAD') ||
          ((fetched.status === 301 || fetched.status === 302) && method === 'POST');
        const nextHeaders = new Headers(headers);
        if (toGet) {
          for (const name of ['Content-Type', 'Idempotency-Key', 'If-Match']) nextHeaders.delete(name);
        }
        return this.#send(
          toGet ? 'GET' : method,
          next.toString(),
          nextHeaders,
          toGet ? undefined : body,
          signal,
          failed,
          hop + 1,
        );
      }
    }
    return new Response(NO_BODY_STATUSES.has(fetched.status) ? null : bytes, {
      status: fetched.status,
      statusText: fetched.statusText,
      headers: fetched.headers,
    });
  }

  async #dispatch(request: Request, timeout: AbortSignal, caller: AbortSignal | undefined) {
    const signal = caller ? AbortSignal.any([timeout, caller]) : timeout;
    const body = request.body ? await request.text() : undefined;
    const failed = (cause: unknown): unknown => {
      if (caller?.aborted) return caller.reason;
      const url = this.redactUrl(request.url);
      if (timeout.aborted) return new RaskTimeoutError({ message: `${request.method} ${url} timed out`, cause });
      const reason = cause instanceof Error ? cause.message : String(cause);
      return new RaskConnectionError({ message: `${request.method} ${url} failed: ${reason}`, cause });
    };
    return this.#send(request.method, request.url, request.headers, body, signal, failed);
  }

  #warn(operationId: string, headers: Headers): void {
    const deprecation = headers.get('deprecation');
    if (deprecation === null || this.#warned.has(operationId)) return;
    this.#warned.add(operationId);
    const sunset = headers.get('sunset') ?? undefined;
    const link = headers.get('link') ?? undefined;
    const after = sunset ? `, and goes away after ${sunset}` : '';
    const message = `Rask API: ${operationId} is deprecated${after}.${link ? ` See ${link}.` : ''}`;
    this.#config.onDeprecation({ operationId, deprecation, sunset, link, message });
  }

  #check(op: OperationMeta, params: OperationParams): void {
    for (const name of op.pathParams) {
      const value = params.path?.[name];
      if (value === undefined || value === null || value === '') {
        throw new RaskConfigError({ message: `${op.id} requires the path parameter ${name}.` });
      }
      // The URL parser resolves a dot segment away, and the same method with the key would address another resource.
      if (value === '.' || value === '..') {
        throw new RaskConfigError({ message: `${op.id}: the path parameter ${name} cannot be "${value}".` });
      }
    }
    if (op.ifMatch === 'required' && !params.ifMatch) {
      throw new RaskConfigError({
        message: `${op.id} requires ifMatch (if_match, sent as If-Match): pass the ETag you read, quotes included.`,
      });
    }
  }

  /** One logical call: every attempt of it carries the same key and the same body. */
  async call<T>(op: OperationMeta, lowLevel: LowLevelCall, params: OperationParams = {}): Promise<RaskResponse<T>> {
    this.#check(op, params);
    const key = op.idempotencyKey === 'none' ? undefined : (params.idempotencyKey ?? crypto.randomUUID());
    const headers: Record<string, string> = {};
    if (key !== undefined) headers['Idempotency-Key'] = key;
    if (params.ifMatch !== undefined) headers['If-Match'] = params.ifMatch;
    if (params.ifNoneMatch !== undefined) headers['If-None-Match'] = params.ifNoneMatch;

    const timeoutMs = (params.timeoutSeconds ?? this.timeoutSeconds) * 1000;
    const started = Date.now();
    let attempt = 0;
    let keyInUseRetries = 0;
    for (;;) {
      params.signal?.throwIfAborted();
      const remaining = RETRY_BUDGET_MS - (Date.now() - started);
      // The first attempt gets the whole timeout. A later one also has to end within the budget.
      const timeout = AbortSignal.timeout(attempt === 0 ? timeoutMs : Math.min(timeoutMs, Math.max(remaining, 1)));
      const { data, error, response } = (await (lowLevel as (options: unknown) => Promise<unknown>)({
        client: this.#client,
        path: params.path,
        query: params.query,
        body: params.body,
        headers,
        throwOnError: false,
        fetch: (request: Request) => this.#dispatch(request, timeout, params.signal),
      })) as LowLevelResult;

      let failure: RaskError;
      let retry = false;
      if (!response) {
        // Thrown by #dispatch: anything but a connection failure, such as the caller's abort, ends the call.
        if (!(error instanceof RaskConnectionError)) throw error;
        failure = error;
        retry = true;
      } else {
        this.#warn(op.id, response.headers);
        const notModified = response.status === 304 && params.ifNoneMatch !== undefined;
        if ((response.ok && error === undefined) || notModified) {
          return this.#result<T>(response, notModified || response.status === 204 ? undefined : data, key);
        }
        if (response.ok) {
          throw new RaskError({
            status: response.status,
            headers: response.headers,
            idempotencyKey: key,
            cause: error,
            message: `${op.id}: the ${response.status} response could not be parsed`,
          });
        }
        failure = errorFromResponse(response.status, error, response.headers, key);
        if (response.status === 409 && failure.code === 'idempotency_key_in_use') {
          retry = keyInUseRetries < KEY_IN_USE_RETRIES;
          keyInUseRetries += 1;
        } else {
          retry = RETRY_STATUSES.has(response.status);
        }
      }

      const wait = Math.max(backoffMs(attempt), (failure.retryAfter ?? 0) * 1000);
      if (!retry || Date.now() - started + wait > RETRY_BUDGET_MS) {
        if (failure.idempotencyKey === undefined && key !== undefined) {
          (failure as { idempotencyKey: string | undefined }).idempotencyKey = key;
        }
        throw failure;
      }
      attempt += 1;
      this.log(`retry ${attempt} of ${op.id} in ${Math.round(wait)}ms: ${failure.status ?? failure.message}`);
      await sleep(wait, params.signal);
    }
  }

  /** A list operation: await it for the page, or `for await` it for the items of every page. */
  list<L extends ListBody>(op: OperationMeta, lowLevel: LowLevelCall, params: OperationParams = {}): PagePromise<L> {
    const load = async (cursor: string | undefined): Promise<Page<L>> => {
      const query = cursor === undefined ? params.query : { ...params.query, cursor };
      const response = await this.call<L>(op, lowLevel, { ...params, query });
      return new Page<L>(response, load);
    };
    return new PagePromise<L>(() => load(undefined));
  }

  #result<T>(response: Response, data: unknown, key: string | undefined): RaskResponse<T> {
    const { headers, status } = response;
    return {
      data: data as T,
      status,
      headers,
      requestId: headers.get('x-request-id') ?? undefined,
      idempotencyKey: key,
      etag: headers.get('etag') ?? undefined,
      location: headers.get('location') ?? undefined,
      idempotentReplayed: headers.get('idempotent-replayed') === 'true',
    };
  }
}

export const retryAfterMs = (headers: Headers): number | undefined => {
  const seconds = retryAfterSeconds(headers);
  return seconds === undefined ? undefined : seconds * 1000;
};
