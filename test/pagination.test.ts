import { describe, expect, it } from 'vitest';
import { Rask, type RaskError } from '../src/index';
import { BASE, json, stubFetch, TEST_KEY } from './helpers';

const pages = () => [
  json({ object: 'list', data: [{ id: 'a' }], next_cursor: 'c2', has_more: true }),
  json({ object: 'list', data: [], next_cursor: 'c3', has_more: true }),
  json({ object: 'list', data: [{ id: 'b' }], next_cursor: null, has_more: false }),
];

describe('list operations', () => {
  it('send nothing until awaited or iterated', async () => {
    const { fetch, calls } = stubFetch(pages());
    const rask = new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch });
    const list = rask.projects.listProjects({ query: { limit: 1, name_contains: 'q' } });
    expect(calls).toHaveLength(0);
    await list;
    expect(calls).toHaveLength(1);
  });

  it('walk every page from a PagePromise and keep the filters', async () => {
    const { fetch, calls } = stubFetch(pages());
    const rask = new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch });
    const ids: string[] = [];
    for await (const project of rask.projects.listProjects({ query: { limit: 1, name_contains: 'q' } })) {
      ids.push(project.id);
    }
    expect(ids).toEqual(['a', 'b']);
    expect(calls.map((call) => new URL(call.url).search)).toEqual([
      '?limit=1&name_contains=q',
      '?limit=1&name_contains=q&cursor=c2',
      '?limit=1&name_contains=q&cursor=c3',
    ]);
  });

  it('give page-level access, and walk on from a page', async () => {
    const { fetch, calls } = stubFetch(pages());
    const rask = new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch });
    const first = await rask.projects.listProjects();
    expect(first).toMatchObject({ status: 200, hasMore: true, nextCursor: 'c2' });
    expect(first.items).toEqual([{ id: 'a' }]);
    expect(first.data.has_more).toBe(true);
    expect(calls).toHaveLength(1);

    const second = await first.nextPage();
    expect(second?.items).toEqual([]);
    const third = await second?.nextPage();
    expect(third?.hasMore).toBe(false);
    expect(await third?.nextPage()).toBeNull();
    expect(calls).toHaveLength(3);

    const seen: unknown[] = [];
    for await (const item of third as NonNullable<typeof third>) seen.push(item);
    expect(seen).toEqual([{ id: 'b' }]);
    expect(calls).toHaveLength(3);
  });

  it('reuse the first page when awaited and then iterated', async () => {
    const { fetch, calls } = stubFetch(pages());
    const rask = new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch });
    const list = rask.projects.listProjects();
    await list;
    const seen: unknown[] = [];
    for await (const item of list) seen.push(item);
    expect(seen).toHaveLength(2);
    expect(calls).toHaveLength(3);
  });

  it('raise the first page error through await and through iteration', async () => {
    const reply = () => json({ status: 404, code: 'nope' }, 404);
    const { fetch } = stubFetch([reply(), reply()]);
    const rask = new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch });
    await expect(rask.projects.listProjects().catch((error) => (error as RaskError).code)).resolves.toBe('nope');
    const iterate = async () => {
      for await (const _ of rask.projects.listProjects()) {
        // Never reached.
      }
    };
    await expect(iterate()).rejects.toMatchObject({ code: 'nope' });
  });

  it('stop with an error when a page answers with the cursor it was asked for with', async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      return json({ object: 'list', data: [{ id: `p${calls}` }], next_cursor: 'c2', has_more: true });
    }) as typeof globalThis.fetch;
    const rask = new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch });
    const ids: string[] = [];
    const iterate = async () => {
      for await (const project of rask.projects.listProjects()) {
        ids.push(project.id);
        // Without the check the walk has no end, and this test has to have one.
        if (ids.length === 10) break;
      }
    };
    await expect(iterate()).rejects.toThrow('cursor');
    expect(ids).toEqual(['p1', 'p2']);
    expect(calls).toBe(2);
  });

  it('stop with an error when the cursors go round in a cycle', async () => {
    let calls = 0;
    const fetch = (async () => {
      calls += 1;
      // a, b, a, b: no page answers with the cursor it was asked for with.
      return json({ object: 'list', data: [{ id: `p${calls}` }], next_cursor: calls % 2 ? 'a' : 'b', has_more: true });
    }) as typeof globalThis.fetch;
    const rask = new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch });
    const ids: string[] = [];
    const iterate = async () => {
      for await (const project of rask.projects.listProjects()) {
        ids.push(project.id);
        if (ids.length === 10) break;
      }
    };
    await expect(iterate()).rejects.toThrow('cursor');
    expect(ids).toEqual(['p1', 'p2', 'p3']);
    expect(calls).toBe(3);
  });
});
