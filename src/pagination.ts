import { RaskError } from './errors';
import type { RaskResponse } from './transport';

/** The list envelope every paged operation answers with. */
export interface ListBody {
  data: unknown[];
  next_cursor?: string | null;
  has_more?: boolean;
}

export type ListItem<L extends ListBody> = L['data'][number];

/**
 * One page. `data` is the whole list body as received; `items` its items. `for await` walks this page's items and those
 * of the following pages, asking for each only when it is reached.
 */
export class Page<L extends ListBody> implements RaskResponse<L>, AsyncIterable<ListItem<L>> {
  readonly data: L;
  readonly status: number;
  readonly headers: Headers;
  readonly requestId: string | undefined;
  readonly idempotencyKey: string | undefined;
  readonly etag: string | undefined;
  readonly location: string | undefined;
  readonly idempotentReplayed: boolean;
  #load: (cursor: string) => Promise<Page<L>>;

  constructor(response: RaskResponse<L>, load: (cursor: string) => Promise<Page<L>>) {
    this.data = response.data;
    this.status = response.status;
    this.headers = response.headers;
    this.requestId = response.requestId;
    this.idempotencyKey = response.idempotencyKey;
    this.etag = response.etag;
    this.location = response.location;
    this.idempotentReplayed = response.idempotentReplayed;
    this.#load = load;
  }

  get items(): ListItem<L>[] {
    return this.data.data;
  }

  get nextCursor(): string | null {
    return this.data.next_cursor ?? null;
  }

  /** A page may hold fewer than `limit` items, even none, while more follow. */
  get hasMore(): boolean {
    return this.nextCursor !== null;
  }

  /** The next page, or null after the last. The same filters are sent again. */
  async nextPage(): Promise<Page<L> | null> {
    const cursor = this.nextCursor;
    return cursor === null ? null : this.#load(cursor);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ListItem<L>, void, undefined> {
    let page: Page<L> | null = this;
    // Every cursor the server has given on this walk, not only the last: a cycle such as A, B, A never repeats one in
    // a row.
    const given = new Set<string>();
    while (page) {
      yield* page.items;
      const next = page.nextCursor;
      if (next !== null) {
        // Following a cursor a second time would get the same pages, for ever.
        if (given.has(next)) {
          throw new RaskError({
            status: page.status,
            headers: page.headers,
            message: 'The list gave a cursor it had already given, so walking it would never end.',
          });
        }
        given.add(next);
      }
      page = await page.nextPage();
    }
  }
}

/** What a list operation returns: `await` gives the first page, and `for await` every item of every page. */
export class PagePromise<L extends ListBody> implements PromiseLike<Page<L>>, AsyncIterable<ListItem<L>> {
  #load: () => Promise<Page<L>>;
  #first: Promise<Page<L>> | undefined;

  constructor(load: () => Promise<Page<L>>) {
    this.#load = load;
  }

  #start(): Promise<Page<L>> {
    this.#first ??= this.#load();
    return this.#first;
  }

  // biome-ignore lint/suspicious/noThenProperty: this class is a PromiseLike on purpose.
  then<A = Page<L>, B = never>(
    onFulfilled?: ((page: Page<L>) => A | PromiseLike<A>) | null,
    onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null,
  ): Promise<A | B> {
    return this.#start().then(onFulfilled, onRejected);
  }

  catch<B = never>(onRejected?: ((reason: unknown) => B | PromiseLike<B>) | null): Promise<Page<L> | B> {
    return this.#start().catch(onRejected);
  }

  finally(onFinally?: (() => void) | null): Promise<Page<L>> {
    return this.#start().finally(onFinally);
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<ListItem<L>, void, undefined> {
    yield* await this.#start();
  }
}
