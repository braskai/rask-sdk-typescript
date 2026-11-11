import type { CallOptions, Transport } from './transport';

type WireKey = 'path' | 'query' | 'body';
type WireKeys<D> = {
  [K in keyof D]-?: K extends WireKey ? ([Exclude<D[K], undefined>] extends [never] ? never : K) : never;
}[keyof D];

/** The arguments of an operation: its `path`, `query` and `body` as the contract names them, plus per-call settings. */
export type Params<D> = Pick<D, WireKeys<D>> & CallOptions;

export interface WithIdempotencyKey {
  /** Sent as Idempotency-Key on every attempt of this call. Default: a new UUIDv4 per call. */
  idempotencyKey?: string;
}

export interface WithIfMatch {
  /** Sent as If-Match: the ETag you read, quotes included. 412 and 428 are never retried automatically. */
  ifMatch: string;
}

export interface WithOptionalIfMatch {
  /** Sent as If-Match: the ETag you read, quotes included. 412 and 428 are never retried automatically. */
  ifMatch?: string;
}

export interface WithIfNoneMatch {
  /** Sent as If-None-Match: the ETag you hold. An unchanged resource answers 304 with `data` undefined. */
  ifNoneMatch?: string;
}

export class Resource {
  protected readonly transport: Transport;
  constructor(transport: Transport) {
    this.transport = transport;
  }
}
