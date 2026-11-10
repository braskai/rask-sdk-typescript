// Every operation, called through its resource, against the contract. The harness rejects any request it does not allow.
import { beforeEach, describe, expect, it } from 'vitest';
import { OPERATIONS, Rask } from '../src/index';
import { type RecordedRequest, useHarness } from './helpers';

interface HarnessOperation {
  operationId: string;
  method: string;
  path: string;
  has_json_response: boolean;
  idempotency_key: string;
  if_match: string;
  sample: {
    path: Record<string, unknown>;
    query: Record<string, unknown>;
    headers: Record<string, string>;
    body: unknown;
  };
}

type Callable = Record<string, Record<string, (params: unknown) => PromiseLike<{ status: number }>>>;

const callSample = (rask: Rask, operation: HarnessOperation) => {
  const { path, query, headers, body } = operation.sample;
  const group = OPERATIONS[operation.operationId as keyof typeof OPERATIONS].group;
  const params = {
    path,
    query,
    ...(body === null ? {} : { body }),
    ...(headers['If-Match'] ? { ifMatch: headers['If-Match'] } : {}),
  };
  return (rask as unknown as Callable)[group]?.[operation.operationId]?.(params);
};

function describeWithPrefix(prefix: string, makeBaseUrl: (baseUrl: string) => string) {
  describe(`under ${prefix}`, () => {
    const harness = useHarness(['--prefix', prefix]);
    beforeEach(() => harness.control.post('/reset'));

    it('calls all 82 operations, each under the prefix, and none breaks the contract', async () => {
      const { operations } = (await harness.control.get('/operations')) as { operations: HarnessOperation[] };
      expect(operations).toHaveLength(82);
      expect(Object.keys(OPERATIONS).sort()).toEqual(operations.map((operation) => operation.operationId).sort());
      const rask = new Rask({ apiKey: harness.apiKey, baseUrl: makeBaseUrl(harness.baseUrl) });
      const outcomes: Array<[string, number]> = [];
      for (const operation of operations) {
        const result = await callSample(rask, operation);
        outcomes.push([operation.operationId, result?.status ?? 0]);
      }
      expect(outcomes.filter(([, status]) => status < 200 || status >= 300)).toEqual([]);

      const recorded = (await harness.requests()) as RecordedRequest[];
      expect(recorded).toHaveLength(82);
      expect(recorded.flatMap((request) => request.violations)).toEqual([]);
      for (const request of recorded) {
        expect(request.listener).toBe('api');
        expect(request.path.startsWith(`${prefix}/`)).toBe(true);
        expect(request.path).not.toContain('//');
        expect(request.headers.authorization).toBe(`Bearer ${harness.apiKey}`);
      }
    });

    it('keeps the helpers under the prefix too', async () => {
      await harness.control.post('/pages', { operationId: 'listProjects', pages: 2, page_size: 1 });
      await harness.control.post('/jobs', { id: 'job-prefix', type: 'dub', states: ['succeeded'] });
      const rask = new Rask({ apiKey: harness.apiKey, baseUrl: makeBaseUrl(harness.baseUrl) });
      for await (const _ of rask.projects.listProjects({ query: { limit: 1 } })) {
        // Walks both pages.
      }
      await rask.jobs.wait('job-prefix');
      await rask.uploads.uploadFile(new Uint8Array(64), { filename: 'a.mp4' });

      const recorded = (await harness.requests()) as RecordedRequest[];
      const api = recorded.filter((request) => request.operationId !== '__storage_put');
      expect(api.map((request) => request.operationId)).toEqual([
        'listProjects',
        'listProjects',
        'getJob',
        'createUpload',
        'completeUpload',
      ]);
      for (const request of api) {
        expect(request.path.startsWith(`${prefix}/`)).toBe(true);
        expect(request.headers.authorization).toBe(`Bearer ${harness.apiKey}`);
      }
      const put = recorded.find((request) => request.operationId === '__storage_put');
      expect(put?.listener).toBe('other');
      expect(put?.headers.authorization).toBeUndefined();
    });
  });
}

// A path prefix of the same shape as the owner's example, https://gw.example.com/rask/v3, with and without the slash.
describeWithPrefix('/rask/v3', (baseUrl) => baseUrl);
describeWithPrefix('/gw/rask/v3', (baseUrl) => `${baseUrl}/`);
