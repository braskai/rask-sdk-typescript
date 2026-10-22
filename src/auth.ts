import { RaskAuthError } from './errors';

/** Supplies bearer tokens to the HTTP client. */
export interface TokenSource {
  /** Whether a rejected token can be replaced by fetching a new one. */
  readonly refreshable: boolean;
  /** Returns a valid access token, fetching a new one when needed. */
  getToken(forceRefresh?: boolean): Promise<string>;
  /** Drops `token` from the cache if it is still the cached token. */
  invalidate(token: string): void;
}

export interface ClientCredentialsConfig {
  clientId: string;
  clientSecret: string;
  tokenUrl: string;
  scopes: readonly string[];
  fetch?: typeof fetch | undefined;
  /** Clock override for tests. */
  now?: () => number;
}

/** Refresh this long before `expires_in` runs out (capped at half the lifetime). */
const EXPIRY_MARGIN_MS = 60_000;
/** Used when the token endpoint omits `expires_in` (Cognito default lifetime). */
const DEFAULT_EXPIRES_IN_SECONDS = 3600;

/**
 * OAuth2 client credentials grant (`client_secret_post`) against the Rask
 * Cognito token endpoint. Tokens are cached until shortly before they expire and
 * concurrent callers share a single in-flight token request.
 */
export class ClientCredentialsTokenSource implements TokenSource {
  readonly refreshable = true;
  readonly #config: ClientCredentialsConfig;
  #cached: { token: string; expiresAt: number } | undefined;
  #inflight: Promise<string> | undefined;

  constructor(config: ClientCredentialsConfig) {
    this.#config = config;
  }

  getToken(forceRefresh = false): Promise<string> {
    const cached = this.#cached;
    if (!forceRefresh && cached && this.#now() < cached.expiresAt) {
      return Promise.resolve(cached.token);
    }
    if (!this.#inflight) {
      this.#inflight = this.#fetchToken().finally(() => {
        this.#inflight = undefined;
      });
    }
    return this.#inflight;
  }

  invalidate(token: string): void {
    if (this.#cached?.token === token) {
      this.#cached = undefined;
    }
  }

  #now(): number {
    return (this.#config.now ?? Date.now)();
  }

  async #fetchToken(): Promise<string> {
    const { clientId, clientSecret, tokenUrl, scopes } = this.#config;
    const fetchImpl = this.#config.fetch ?? globalThis.fetch;
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: clientId,
      client_secret: clientSecret,
    });
    if (scopes.length > 0) {
      body.set('scope', scopes.join(' '));
    }

    // Network failures propagate as the runtime's own fetch error, as for API calls.
    const response = await fetchImpl(tokenUrl, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: body.toString(),
    });

    const text = await response.text();
    let payload: unknown = text;
    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      // keep the raw text
    }

    const token = readTokenPayload(payload);
    if (!response.ok || !token) {
      const reason =
        typeof payload === 'object' && payload !== null && 'error' in payload
          ? `: ${String((payload as { error: unknown }).error)}`
          : '';
      throw new RaskAuthError({
        status: response.status,
        body: payload,
        response,
        message: `Rask authentication failed with status ${response.status}${reason}`,
      });
    }

    const lifetimeMs = token.expiresIn * 1000;
    const margin = Math.min(EXPIRY_MARGIN_MS, lifetimeMs / 2);
    this.#cached = { token: token.accessToken, expiresAt: this.#now() + lifetimeMs - margin };
    return token.accessToken;
  }
}

const readTokenPayload = (payload: unknown): { accessToken: string; expiresIn: number } | undefined => {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const { access_token: accessToken, expires_in: expiresIn } = payload as Record<string, unknown>;
  if (typeof accessToken !== 'string' || accessToken === '') return undefined;
  const seconds = Number(expiresIn);
  return {
    accessToken,
    expiresIn: Number.isFinite(seconds) && seconds > 0 ? seconds : DEFAULT_EXPIRES_IN_SECONDS,
  };
};

/** A caller-provided access token (or token getter). It is never refreshed by the SDK. */
export class StaticTokenSource implements TokenSource {
  readonly refreshable = false;
  readonly #token: string | (() => string | Promise<string>);

  constructor(token: string | (() => string | Promise<string>)) {
    this.#token = token;
  }

  async getToken(): Promise<string> {
    return typeof this.#token === 'function' ? this.#token() : this.#token;
  }

  invalidate(): void {}
}
