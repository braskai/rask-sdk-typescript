import { JobCanceledError, JobFailedError, RaskConnectionError, RaskError, WaitTimeoutError } from './errors';
import { JobsResource } from './generated/resources.gen';
import type { Job } from './generated/types.gen';
import { backoffMs, type RaskResponse, retryAfterMs, sleep } from './transport';

export const DEFAULT_WAIT_TIMEOUT_SECONDS = 14_400;
const LONG_POLL_SECONDS = 20;
// What a long-poll takes at most: the hold plus the server's own budget of 25 s.
const LONG_POLL_REQUEST_SECONDS = LONG_POLL_SECONDS + 25;
const DEFAULT_POLL_MS = 1000;
const TRANSIENT_STATUSES = new Set([429, 502, 503, 504]);

export interface WaitOptions {
  /** How long to wait for the job. Default 14400 s (4 h). The job is left running when this runs out. */
  timeoutSeconds?: number;
  /** Stops waiting. The job is left running. */
  signal?: AbortSignal;
}

const isTransient = (error: unknown): error is RaskError =>
  error instanceof RaskConnectionError ||
  (error instanceof RaskError && error.status !== undefined && TRANSIENT_STATUSES.has(error.status));

export class Jobs extends JobsResource {
  /**
   * Waits until the job is finished and returns it when it succeeded. Long-polls getJob (`wait_seconds=20`), honours
   * `Retry-After`, and keeps waiting through outages and through statuses this version does not know.
   *
   * @throws JobFailedError with the job's problem, JobCanceledError, or WaitTimeoutError.
   */
  async wait(jobId: string, options: WaitOptions = {}): Promise<RaskResponse<Job>> {
    const timeoutSeconds = options.timeoutSeconds ?? DEFAULT_WAIT_TIMEOUT_SECONDS;
    const deadlineAt = Date.now() + timeoutSeconds * 1000;
    const deadline = AbortSignal.timeout(timeoutSeconds * 1000);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    let etag: string | undefined;
    let last: Job | undefined;
    let outages = 0;
    for (;;) {
      let waitMs: number;
      try {
        const remaining = Math.ceil((deadlineAt - Date.now()) / 1000);
        const response = await this.getJob({
          path: { job_id: jobId },
          query: { wait_seconds: Math.max(0, Math.min(LONG_POLL_SECONDS, remaining)) },
          ...(etag === undefined ? {} : { ifNoneMatch: etag }),
          // A client with a shorter timeout would otherwise cut off every poll and never see the job end.
          timeoutSeconds: Math.max(this.transport.timeoutSeconds, LONG_POLL_REQUEST_SECONDS),
          signal,
        });
        outages = 0;
        if (response.data !== undefined) {
          const job = response.data;
          last = job;
          etag = response.etag;
          if (job.status === 'succeeded') return response as RaskResponse<Job>;
          if (job.status === 'failed') throw new JobFailedError(job);
          if (job.status === 'canceled') throw new JobCanceledError(job);
        }
        waitMs = retryAfterMs(response.headers) ?? DEFAULT_POLL_MS;
      } catch (error) {
        // The job's own end is no outage, whatever status its problem carries: a finished job answers the same again.
        if (error instanceof JobFailedError || error instanceof JobCanceledError) throw error;
        if (deadline.aborted) throw new WaitTimeoutError(jobId, timeoutSeconds, last);
        if (!isTransient(error)) throw error;
        // The call already spent its retries. An outage shorter than the timeout still does not end the wait.
        waitMs = Math.max(backoffMs(outages), (error.retryAfter ?? 0) * 1000);
        outages += 1;
      }
      if (Date.now() + waitMs >= deadlineAt) throw new WaitTimeoutError(jobId, timeoutSeconds, last);
      try {
        await sleep(waitMs, signal);
      } catch (error) {
        if (deadline.aborted) throw new WaitTimeoutError(jobId, timeoutSeconds, last);
        throw error;
      }
    }
  }
}
