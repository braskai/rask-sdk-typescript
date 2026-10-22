import type { ValidationError } from './generated/types.gen';

export interface RaskApiErrorInit {
  status: number;
  body: unknown;
  response?: Response | undefined;
  request?: Request | undefined;
  message?: string | undefined;
}

/**
 * Thrown by every `RaskClient` method when the API answers with a non-2xx status.
 *
 * The response body has already been read; use `body` / `detail` rather than
 * `response.json()`.
 */
export class RaskApiError extends Error {
  override readonly name: string = 'RaskApiError';
  /** HTTP status code. */
  readonly status: number;
  /** Parsed JSON error body, or the raw text when the body is not JSON. */
  readonly body: unknown;
  /**
   * FastAPI-style `detail` field when present: usually a message string, or a
   * list of {@link ValidationError} entries for 422 responses. `undefined` when
   * the body has no `detail`.
   */
  readonly detail: unknown;
  /** The HTTP response (body already consumed). */
  readonly response: Response | undefined;
  /** The HTTP request that failed. */
  readonly request: Request | undefined;

  constructor(init: RaskApiErrorInit) {
    const detail = extractDetail(init.body);
    super(init.message ?? `Rask API request failed with status ${init.status}${describe(detail ?? init.body)}`);
    this.status = init.status;
    this.body = init.body;
    this.detail = detail;
    this.response = init.response;
    this.request = init.request;
  }
}

/**
 * Thrown when an OAuth2 access token cannot be obtained from the token endpoint
 * (for example: invalid client credentials). `body` holds the token endpoint's
 * error payload, e.g. `{ "error": "invalid_client" }`.
 */
export class RaskAuthError extends RaskApiError {
  override readonly name: string = 'RaskAuthError';
}

const extractDetail = (body: unknown): unknown =>
  typeof body === 'object' && body !== null && 'detail' in body
    ? (body as { detail: unknown }).detail
    : undefined;

const MAX_MESSAGE_DETAIL = 500;

const describe = (value: unknown): string => {
  let text: string;
  if (value === undefined || value === null || value === '') {
    return '';
  } else if (typeof value === 'string') {
    text = value;
  } else if (Array.isArray(value) && value.every(isValidationError)) {
    text = value.map((item) => `${item.loc.join('.')}: ${item.msg}`).join('; ');
  } else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return `: ${text.length > MAX_MESSAGE_DETAIL ? `${text.slice(0, MAX_MESSAGE_DETAIL)}…` : text}`;
};

const isValidationError = (value: unknown): value is ValidationError =>
  typeof value === 'object' &&
  value !== null &&
  Array.isArray((value as ValidationError).loc) &&
  typeof (value as ValidationError).msg === 'string';
