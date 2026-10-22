import type { RaskClient } from './client';

export { RaskClient, type RaskClientOptions } from './client';
export { RaskApiError, RaskAuthError, type RaskApiErrorInit } from './errors';
export { DEFAULT_BASE_URL, DEFAULT_SCOPES, DEFAULT_TOKEN_URL } from './constants';

// Generated from openapi/openapi.yml: the low-level SDK class, schema types and
// enum objects (e.g. `ProjectStatus.MERGING_DONE`).
export { RaskApi, type Options as RequestOptions } from './generated/sdk.gen';
export * from './generated/types.gen';

/** Names of all API operations available on {@link RaskClient}. */
export type RaskOperation = {
  [K in keyof RaskClient]: K extends 'getAccessToken'
    ? never
    : RaskClient[K] extends (...args: never[]) => unknown
      ? K
      : never;
}[keyof RaskClient];

/** Parameter object accepted by an operation, e.g. `RaskParams<'createProject'>`. */
export type RaskParams<K extends RaskOperation> = Parameters<RaskClient[K]>[0];
