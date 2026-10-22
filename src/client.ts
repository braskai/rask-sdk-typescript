import {
  ClientCredentialsTokenSource,
  StaticTokenSource,
  type TokenSource,
} from './auth';
import { DEFAULT_BASE_URL, DEFAULT_SCOPES, DEFAULT_TOKEN_URL } from './constants';
import { RaskApiError, RaskAuthError } from './errors';
import { type Client, createClient, createConfig, type RequestResult } from './generated/client';
import { type Options, RaskApi } from './generated/sdk.gen';
import type { CreateTranscriptionSrtErrors, CreateTranscriptionSrtResponses } from './generated/types.gen';

interface CommonOptions {
  /** API base URL. Defaults to `https://api.rask.ai`. */
  baseUrl?: string;
  /** Custom `fetch` implementation (used for API and token requests). Defaults to `globalThis.fetch`. */
  fetch?: typeof fetch;
}

interface ClientCredentialsOptions extends CommonOptions {
  /** OAuth2 client ID from your Rask API settings. */
  clientId: string;
  /** OAuth2 client secret. Keep it server-side; never ship it to browsers. */
  clientSecret: string;
  /** OAuth2 token endpoint. Defaults to the Rask production Cognito endpoint. */
  tokenUrl?: string;
  /** OAuth2 scopes to request. Defaults to `api/source api/input api/output api/limit`. */
  scopes?: readonly string[];
  accessToken?: never;
}

interface AccessTokenOptions extends CommonOptions {
  /**
   * A pre-obtained access token, or a function returning one (called before
   * every request). The SDK never refreshes it; a 401 is thrown as `RaskApiError`.
   */
  accessToken: string | (() => string | Promise<string>);
  clientId?: never;
  clientSecret?: never;
  tokenUrl?: never;
  scopes?: never;
}

export type RaskClientOptions = ClientCredentialsOptions | AccessTokenOptions;

/**
 * Rask AI API client.
 *
 * Every API operation is a method named after its OpenAPI `operationId`. Methods
 * take one flat object with path, query and body fields, resolve to the parsed
 * response body and throw {@link RaskApiError} on non-2xx responses.
 *
 * @example
 * ```ts
 * const rask = new RaskClient({ clientId, clientSecret });
 * const project = await rask.getProject({ project_id: id });
 * ```
 */
export class RaskClient extends RaskApi {
  readonly #tokens: TokenSource;

  constructor(options: RaskClientOptions) {
    const tokens = createTokenSource(options);
    super({ client: createHttpClient(options, tokens) });
    this.#tokens = tokens;
  }

  /**
   * Returns the bearer token used for API requests, fetching (and caching) a new
   * one via client credentials when needed.
   */
  getAccessToken(options?: { forceRefresh?: boolean }): Promise<string> {
    return this.#tokens.getToken(options?.forceRefresh ?? false);
  }

  /**
   * Create transcription from `.srt` files (`src` and/or `dst`, any `Blob`).
   *
   * The API only accepts multipart files whose name has a single `.srt`
   * extension, so the parts are always sent as `src.srt` / `dst.srt`.
   */
  override createTranscriptionSrt<ThrowOnError extends boolean = true>(
    parameters?: Parameters<RaskApi['createTranscriptionSrt']>[0],
    options?: Options<never, ThrowOnError>,
  ): RequestResult<CreateTranscriptionSrtResponses, CreateTranscriptionSrtErrors, ThrowOnError, 'data'> {
    return super.createTranscriptionSrt(parameters, { bodySerializer: srtFormDataSerializer, ...options });
  }
}

/** Like the generated multipart serializer, but names every file part `<field>.srt`. */
const srtFormDataSerializer = (body: unknown): FormData => {
  const form = new FormData();
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (value === undefined || value === null) continue;
    if (value instanceof Blob) {
      form.append(key, value, `${key}.srt`);
    } else {
      form.append(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
  }
  return form;
};

const createTokenSource = (options: RaskClientOptions): TokenSource => {
  if (options.accessToken !== undefined) {
    if (options.clientId !== undefined || options.clientSecret !== undefined) {
      throw new TypeError('RaskClient: pass either `accessToken` or `clientId`/`clientSecret`, not both.');
    }
    return new StaticTokenSource(options.accessToken);
  }
  if (!options.clientId || !options.clientSecret) {
    throw new TypeError('RaskClient: `clientId` and `clientSecret` are required (or pass `accessToken`).');
  }
  return new ClientCredentialsTokenSource({
    clientId: options.clientId,
    clientSecret: options.clientSecret,
    tokenUrl: options.tokenUrl ?? DEFAULT_TOKEN_URL,
    scopes: options.scopes ?? DEFAULT_SCOPES,
    fetch: options.fetch,
  });
};

const HTTP_METHODS = ['delete', 'get', 'head', 'options', 'patch', 'post', 'put', 'trace'] as const;

type RequestFn = (options: { body?: unknown; headers?: unknown }) => Promise<unknown>;

/**
 * Builds the generated fetch client with bearer auth, `RaskApiError` mapping
 * and a single refresh-and-retry when the API rejects the token with a 401.
 */
const createHttpClient = (options: RaskClientOptions, tokens: TokenSource): Client => {
  const base = createClient(
    createConfig({
      baseUrl: options.baseUrl ?? DEFAULT_BASE_URL,
      throwOnError: true,
      auth: () => tokens.getToken(),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    }),
  );
  base.interceptors.error.use(toRaskApiError);

  const withAuthRetry =
    (call: RequestFn): RequestFn =>
    async (requestOptions) => {
      const opts = withRequiredJsonBody(requestOptions);
      try {
        return await call(opts);
      } catch (error) {
        if (!tokens.refreshable || !isRejectedToken(error)) throw error;
        tokens.invalidate(bearerToken(error.request));
        // Options are rebuilt into a fresh Request, so bodies (Blobs, JSON) are re-sent intact.
        return call(opts);
      }
    };

  const client: Record<string, unknown> = { ...base, request: withAuthRetry(base.request as RequestFn) };
  for (const method of HTTP_METHODS) {
    client[method] = withAuthRetry(base[method] as RequestFn);
  }
  return client as unknown as Client;
};

const toRaskApiError = (
  error: unknown,
  response: Response | undefined,
  request: Request | undefined,
): unknown => {
  // Network failures, token errors and parse errors on 2xx pass through unchanged.
  if (error instanceof RaskApiError || !response || response.ok) return error;
  return new RaskApiError({
    status: response.status,
    body: error === '' ? undefined : error,
    response,
    request,
  });
};

const isRejectedToken = (error: unknown): error is RaskApiError =>
  error instanceof RaskApiError && !(error instanceof RaskAuthError) && error.status === 401;

const bearerToken = (request: Request | undefined): string =>
  request?.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') ?? '';

/**
 * Operations with a JSON request body (all marked required in the spec) must
 * send one even when every field is optional and omitted, e.g.
 * `runLipsyncTask({ project_id })`; FastAPI answers 422 to a missing body.
 */
const withRequiredJsonBody = <T extends { body?: unknown; headers?: unknown }>(options: T): T => {
  if (options.body !== undefined || !isJsonContentType(options.headers)) return options;
  return { ...options, body: {} };
};

const isJsonContentType = (headers: unknown): boolean => {
  if (typeof headers !== 'object' || headers === null || headers instanceof Headers) return false;
  return Object.entries(headers).some(
    ([name, value]) => name.toLowerCase() === 'content-type' && value === 'application/json',
  );
};
