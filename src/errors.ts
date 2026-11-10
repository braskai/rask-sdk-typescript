import type { Job, Problem } from './generated/types.gen';

/** A problem document: the contract's members plus anything newer, which is kept as received. */
export type ProblemBody = Partial<Problem> & Record<string, unknown>;

export interface RaskErrorInit {
  message?: string;
  status?: number | undefined;
  problem?: ProblemBody | null;
  body?: unknown;
  headers?: Headers | undefined;
  idempotencyKey?: string | undefined;
  cause?: unknown;
}

const parseRetryAfter = (value: string | null | undefined): number | undefined => {
  if (value === null || value === undefined || value.trim() === '') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds);
  const at = Date.parse(value);
  return Number.isNaN(at) ? undefined : Math.max(0, (at - Date.now()) / 1000);
};

/** Retry-After in seconds: a number or an HTTP date. Undefined when absent or unreadable. */
export const retryAfterSeconds = (headers: Headers | undefined): number | undefined =>
  parseRetryAfter(headers?.get('retry-after'));

const describe = ({ message, status, problem }: RaskErrorInit): string => {
  if (message) return message;
  const label = [status, problem?.code].filter((part) => part !== undefined).join(' ');
  const detail = problem?.detail ?? problem?.title ?? 'Request failed';
  return label ? `${label}: ${detail}` : String(detail);
};

/**
 * The base of everything this SDK raises. `problem` holds the whole problem document as received, so a member or a
 * `code` this version has never heard of is still there.
 */
export class RaskError extends Error {
  readonly status: number | undefined;
  readonly problem: ProblemBody | null;
  /** The parsed or raw error body, also when it was not a problem document (an HTML page from a gateway). */
  readonly body: unknown;
  readonly headers: Headers | undefined;
  readonly requestId: string | undefined;
  readonly idempotencyKey: string | undefined;
  /** Retry-After in seconds, when the response carried one. */
  readonly retryAfter: number | undefined;

  constructor(init: RaskErrorInit = {}) {
    super(describe(init), init.cause === undefined ? undefined : { cause: init.cause });
    this.name = new.target.name;
    this.status = init.status;
    this.problem = init.problem ?? null;
    this.body = init.body;
    this.headers = init.headers;
    this.requestId = init.headers?.get('x-request-id') ?? undefined;
    this.idempotencyKey = init.idempotencyKey;
    this.retryAfter = retryAfterSeconds(init.headers);
  }

  get code(): string | undefined {
    return this.problem?.code;
  }
  get type(): string | undefined {
    return this.problem?.type;
  }
  get title(): string | undefined {
    return this.problem?.title;
  }
  get detail(): string | undefined {
    return this.problem?.detail;
  }
  get retryable(): boolean | undefined {
    return this.problem?.retryable;
  }
  get retry(): Problem['retry'] | undefined {
    return this.problem?.retry;
  }
  get hint(): string | null | undefined {
    return this.problem?.hint;
  }
  get errors(): Problem['errors'] | undefined {
    return this.problem?.errors;
  }
}

/** Bad configuration or arguments, found before any request is sent. */
export class RaskConfigError extends RaskError {}

/** The connection failed or was lost before a whole response arrived. */
export class RaskConnectionError extends RaskError {}
/** A request ran past its timeout. */
export class RaskTimeoutError extends RaskConnectionError {}

export class BadRequestError extends RaskError {}
export class AuthenticationError extends RaskError {}
export class InsufficientBalanceError extends RaskError {
  get creditType(): Problem['credit_type'] | undefined {
    return this.problem?.credit_type;
  }
  get requiredMinutes(): number | undefined {
    return this.problem?.required_minutes;
  }
  get balanceMinutes(): number | undefined {
    return this.problem?.balance_minutes;
  }
  get requiredProjects(): number | undefined {
    return this.problem?.required_projects;
  }
  get balanceProjects(): number | undefined {
    return this.problem?.balance_projects;
  }
}
export class PermissionDeniedError extends RaskError {}
export class NotFoundError extends RaskError {}
export class ConflictError extends RaskError {}
export class GoneError extends RaskError {}
export class PreconditionFailedError extends RaskError {
  /** The ETag the resource has now. Read the resource again before deciding what to write. */
  get currentEtag(): string | undefined {
    return this.problem?.current_etag;
  }
}
export class PayloadTooLargeError extends RaskError {}
export class UnsupportedMediaTypeError extends RaskError {}
export class ValidationError extends RaskError {}
export class PreconditionRequiredError extends RaskError {}
export class RateLimitError extends RaskError {}
export class InternalServerError extends RaskError {}
export class ServiceUnavailableError extends RaskError {}

const BY_STATUS: Record<number, typeof RaskError> = {
  400: BadRequestError,
  401: AuthenticationError,
  402: InsufficientBalanceError,
  403: PermissionDeniedError,
  404: NotFoundError,
  409: ConflictError,
  410: GoneError,
  412: PreconditionFailedError,
  413: PayloadTooLargeError,
  415: UnsupportedMediaTypeError,
  422: ValidationError,
  428: PreconditionRequiredError,
  429: RateLimitError,
  500: InternalServerError,
  502: ServiceUnavailableError,
  503: ServiceUnavailableError,
  504: ServiceUnavailableError,
};

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The typed error of an HTTP error response. A status without its own class gets the base class. */
export function errorFromResponse(
  status: number,
  body: unknown,
  headers: Headers,
  idempotencyKey: string | undefined,
): RaskError {
  const ErrorClass = BY_STATUS[status] ?? RaskError;
  const problem = isObject(body) && typeof body.code === 'string' ? (body as ProblemBody) : null;
  const message = problem ? undefined : `${status}: the response is not a problem document`;
  return new ErrorClass({ status, problem, body, headers, idempotencyKey, message });
}

/** jobs.wait saw the job fail. `problem` is the job's error. */
export class JobFailedError extends RaskError {
  readonly job: Job;
  constructor(job: Job) {
    const problem = (job.error ?? null) as ProblemBody | null;
    super({ status: problem?.status, problem, message: `Job ${job.id} failed: ${problem?.code ?? 'no error given'}` });
    this.job = job;
  }
}

/** jobs.wait saw the job canceled. */
export class JobCanceledError extends RaskError {
  readonly job: Job;
  constructor(job: Job) {
    const problem = (job.error ?? null) as ProblemBody | null;
    super({ status: problem?.status, problem, message: `Job ${job.id} was canceled` });
    this.job = job;
  }
}

/** jobs.wait ran out of time. The job is left running: wait again with the same id, or cancel it yourself. */
export class WaitTimeoutError extends RaskError {
  readonly jobId: string;
  readonly timeoutSeconds: number;
  /** The last state seen, when any response arrived. */
  readonly job: Job | undefined;
  constructor(jobId: string, timeoutSeconds: number, job: Job | undefined) {
    super({ message: `Job ${jobId} did not finish in ${timeoutSeconds} s` });
    this.jobId = jobId;
    this.timeoutSeconds = timeoutSeconds;
    this.job = job;
  }
}

/** uploads.uploadFile could not store the file. The upload was not completed. */
export class UploadFailedError extends RaskError {
  readonly uploadId: string;
  /** How many PUTs were tried. */
  readonly attempts: number;
  constructor(uploadId: string, attempts: number, init: RaskErrorInit) {
    super(init);
    this.uploadId = uploadId;
    this.attempts = attempts;
  }
}
