import { RaskConfigError } from './errors';
import { RaskResources } from './generated/resources.gen';
import { DEFAULT_WAIT_TIMEOUT_SECONDS, Jobs } from './jobs';
import { type DeprecationNotice, Transport } from './transport';
import { Uploads } from './uploads';
import { VERSION } from './version';

export const DEFAULT_BASE_URL = 'https://api.rask.ai/v3';
const DEFAULT_TIMEOUT_SECONDS = 60;
const INSPECT = Symbol.for('nodejs.util.inspect.custom');

export interface RaskOptions {
  /** Default: the RASK_API_KEY environment variable. */
  apiKey?: string;
  /**
   * The API root, path prefix included, such as `https://gw.example.com/rask/v3`. A trailing slash makes no difference.
   * Default: the RASK_BASE_URL environment variable, then `https://api.rask.ai/v3`.
   */
  baseUrl?: string;
  /** Timeout of each request. Default 60 s, which covers a long-poll of 20 s and the server's budget of 25 s. */
  timeoutSeconds?: number;
  /** `debug` logs every request with secrets redacted. Default: the RASK_LOG environment variable, else off. */
  logLevel?: 'debug' | 'off';
  /** Where debug lines go. Default `console.error`. */
  logger?: (line: string) => void;
  /** Called once per operation, on the first response with a `Deprecation` header. Default `console.warn`. */
  onDeprecation?: (notice: DeprecationNotice) => void;
  /** Replaces the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Allows running in a browser, where anyone who opens the page can read your API key. */
  dangerouslyAllowBrowser?: boolean;
}

export interface RaskConfig {
  readonly baseUrl: string;
  readonly timeoutSeconds: number;
  /** The default of `jobs.wait`. */
  readonly waitTimeoutSeconds: number;
}

interface RuntimeGlobals {
  Bun?: { version?: string };
  Deno?: { version?: { deno?: string }; env?: { get(name: string): string | undefined } };
  process?: { env?: Record<string, string | undefined>; versions?: { node?: string } };
  window?: unknown;
  document?: unknown;
  importScripts?: unknown;
}

const runtime = globalThis as unknown as RuntimeGlobals;

const readEnv = (name: string): string | undefined => {
  try {
    return (runtime.process?.env?.[name] ?? runtime.Deno?.env?.get(name)) || undefined;
  } catch {
    // Deno without --allow-env.
    return undefined;
  }
};

const runtimeToken = (): string => {
  if (runtime.Bun?.version) return `bun/${runtime.Bun.version}`;
  if (runtime.Deno?.version?.deno) return `deno/${runtime.Deno.version.deno}`;
  if (runtime.process?.versions?.node) return `node/${runtime.process.versions.node}`;
  return 'js/unknown';
};

const inBrowser = (): boolean =>
  (runtime.window !== undefined && runtime.document !== undefined) || typeof runtime.importScripts === 'function';

/** Validates a base URL and drops its trailing slashes. The path prefix stays. */
export function normalizeBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RaskConfigError({ message: `The base URL is not a URL: "${raw}".` });
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new RaskConfigError({ message: `The base URL must be http or https, not ${url.protocol}` });
  }
  if (url.username || url.password) {
    throw new RaskConfigError({ message: 'The base URL must not carry credentials. Pass apiKey for the key.' });
  }
  if (url.search || url.hash) {
    throw new RaskConfigError({ message: 'The base URL must not have a query or a fragment.' });
  }
  return `${url.origin}${url.pathname.replace(/\/+$/, '')}`;
}

/**
 * The Rask API v3 client. Every operation of the contract is a method named after its operationId, grouped by resource:
 * `rask.projects.createProject(...)`, `rask.jobs.getJob(...)`. See also `rask.jobs.wait` and `rask.uploads.uploadFile`.
 */
export class Rask extends RaskResources {
  override readonly jobs: Jobs;
  override readonly uploads: Uploads;
  /** What this client resolved its settings to. The key is not among them. */
  readonly config: RaskConfig;

  constructor(options: RaskOptions = {}) {
    if (inBrowser() && !options.dangerouslyAllowBrowser) {
      throw new RaskConfigError({
        message:
          'Rask refuses to run in a browser, where anyone who opens the page can read your API key. Call it from your ' +
          'server, or pass dangerouslyAllowBrowser: true if you accept that.',
      });
    }
    const apiKey = options.apiKey || readEnv('RASK_API_KEY');
    if (!apiKey) throw new RaskConfigError({ message: 'No API key: pass apiKey or set RASK_API_KEY.' });
    // A character outside ASCII may not fit a header at all, and a runtime's refusal of it can quote the whole key.
    if (/[^\x20-\x7e]/.test(apiKey)) {
      throw new RaskConfigError({
        message: 'The API key holds control or non-ASCII characters. Check how it was read.',
      });
    }
    const baseUrl = normalizeBaseUrl(options.baseUrl || readEnv('RASK_BASE_URL') || DEFAULT_BASE_URL);
    const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS;
    if (!(timeoutSeconds > 0)) throw new RaskConfigError({ message: 'timeoutSeconds must be above 0.' });
    const clientId = `rask-sdk-typescript/${VERSION}`;
    const transport = new Transport({
      apiKey,
      baseUrl,
      timeoutSeconds,
      clientId,
      userAgent: `${clientId} ${runtimeToken()}`,
      debug: (options.logLevel ?? readEnv('RASK_LOG')) === 'debug',
      logger: options.logger ?? ((line) => console.error(line)),
      onDeprecation: options.onDeprecation ?? ((notice) => console.warn(notice.message)),
      fetch: options.fetch,
    });
    super(transport);
    this.jobs = new Jobs(transport);
    this.uploads = new Uploads(transport);
    this.config = Object.freeze({ baseUrl, timeoutSeconds, waitTimeoutSeconds: DEFAULT_WAIT_TIMEOUT_SECONDS });
  }

  override toString(): string {
    return `Rask(baseUrl=${this.config.baseUrl})`;
  }

  toJSON(): RaskConfig {
    return this.config;
  }

  [INSPECT](): string {
    return this.toString();
  }
}
