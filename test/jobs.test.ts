import { describe, expect, it, vi } from 'vitest';
import { JobCanceledError, JobFailedError, Rask, ValidationError, WaitTimeoutError } from '../src/index';
import { BASE, json, problem, stubFetch, TEST_KEY } from './helpers';

const job = (status: string, extra: Record<string, unknown> = {}) =>
  json({ id: 'j', status, error: null, ...extra }, 200, { 'Retry-After': '0', ETag: `"${status}"` });

const client = (replies: Parameters<typeof stubFetch>[0]) => {
  const stub = stubFetch(replies);
  return { ...stub, rask: new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch: stub.fetch }) };
};

describe('jobs.wait', () => {
  it('long-polls, sends the last ETag, and returns the succeeded job with its response', async () => {
    const { rask, calls } = client([job('queued'), new Response(null, { status: 304 }), job('succeeded')]);
    const result = await rask.jobs.wait('j');
    expect(result.data.status).toBe('succeeded');
    expect(result.status).toBe(200);
    expect(calls.map((call) => new URL(call.url).search)).toEqual(Array(3).fill('?wait_seconds=20'));
    expect(calls[0]?.headers.get('if-none-match')).toBeNull();
    expect(calls[1]?.headers.get('if-none-match')).toBe('"queued"');
    expect(calls[2]?.headers.get('if-none-match')).toBe('"queued"');
  });

  it('raises JobFailedError carrying the job and its problem', async () => {
    const { rask } = client([job('failed', { error: { status: 422, code: 'dub_failed', detail: 'no' } })]);
    const error = (await rask.jobs.wait('j').catch((caught: unknown) => caught)) as JobFailedError;
    expect(error).toBeInstanceOf(JobFailedError);
    expect(error).toMatchObject({ status: 422, code: 'dub_failed' });
    expect(error.job.id).toBe('j');
  });

  it('raises JobCanceledError, also without an error on the job', async () => {
    const { rask } = client([job('canceled')]);
    await expect(rask.jobs.wait('j')).rejects.toBeInstanceOf(JobCanceledError);
  });

  it('keeps waiting through a status it does not know', async () => {
    const { rask, calls } = client([job('s12_new'), job('succeeded')]);
    await rask.jobs.wait('j');
    expect(calls).toHaveLength(2);
  });

  it('raises other errors at once', async () => {
    const { rask, calls } = client([problem(422, 'validation_failed')]);
    await expect(rask.jobs.wait('j')).rejects.toBeInstanceOf(ValidationError);
    expect(calls).toHaveLength(1);
  });

  it('asks for no longer a hold than the time left', async () => {
    const { rask, calls } = client([json({ id: 'j', status: 'running' }, 200, { 'Retry-After': '60' })]);
    const error = (await rask.jobs
      .wait('j', { timeoutSeconds: 3 })
      .catch((caught: unknown) => caught)) as WaitTimeoutError;
    expect(error).toBeInstanceOf(WaitTimeoutError);
    expect(error).toMatchObject({ jobId: 'j', timeoutSeconds: 3 });
    expect(error.job?.status).toBe('running');
    expect(new URL(calls[0]?.url ?? '').searchParams.get('wait_seconds')).toBe('3');
    expect(calls.some((call) => call.method === 'POST')).toBe(false);
  });

  it('turns a request cut off by the deadline into WaitTimeoutError', async () => {
    const hang = (_: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    const rask = new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch: hang as typeof globalThis.fetch });
    await expect(rask.jobs.wait('j', { timeoutSeconds: 0.05 })).rejects.toBeInstanceOf(WaitTimeoutError);
  });

  it('survives an outage that outlasts the retries of one call', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      let calls = 0;
      const fetch = (async () => {
        calls += 1;
        // A Retry-After past the 120 s budget ends the call's own retries at once, so only the wait loop goes on.
        if (calls <= 2) return new Response('', { status: 503, headers: { 'Retry-After': '121' } });
        return job('succeeded');
      }) as typeof globalThis.fetch;
      const rask = new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch });
      const waiting = rask.jobs.wait('j');
      await vi.advanceTimersByTimeAsync(300_000);
      await expect(waiting).resolves.toMatchObject({ status: 200 });
      expect(calls).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('lets a long-poll finish on a client with a shorter timeout', async () => {
    const slow = () => new Promise<Response>((resolve) => setTimeout(() => resolve(job('succeeded')), 150));
    const fetch = slow as typeof globalThis.fetch;
    const rask = new Rask({ apiKey: TEST_KEY, baseUrl: BASE, fetch, timeoutSeconds: 0.02 });
    await expect(rask.jobs.wait('j')).resolves.toMatchObject({ status: 200 });
  });

  it('stops on the caller signal and does not cancel the job', async () => {
    const controller = new AbortController();
    const { rask, calls } = client([json({ id: 'j', status: 'running' }, 200, { 'Retry-After': '30' })]);
    const waiting = rask.jobs.wait('j', { signal: controller.signal });
    setTimeout(() => controller.abort(new Error('enough')), 30);
    await expect(waiting).rejects.toThrow('enough');
    expect(calls).toHaveLength(1);
  });
});
