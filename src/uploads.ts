import { RaskConfigError, RaskError, RaskTimeoutError, UploadFailedError } from './errors';
import { UploadsResource } from './generated/resources.gen';
import type { CreateUploadRequest, Job, SingleUploadTransfer, Upload } from './generated/types.gen';
import { backoffMs, type RaskResponse, sleep } from './transport';

const PUT_RETRIES = 3;
const MAX_RESIGNS = 3;
const CHUNK_BYTES = 1024 * 1024;

const CONTENT_TYPES: Record<string, CreateUploadRequest['content_type']> = {
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  m4v: 'video/x-m4v',
  '3gp': 'video/3gpp',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  flac: 'audio/flac',
  m4a: 'audio/x-m4a',
};

export type UploadSource =
  | string
  | URL
  | Uint8Array
  | ArrayBuffer
  | Blob
  | ReadableStream<Uint8Array>
  | AsyncIterable<Uint8Array>;

export interface UploadFileOptions {
  /** Default: the base name of a path or the name of a File. Required for bytes and streams. */
  filename?: string;
  /** Default: from the file name's extension. */
  contentType?: CreateUploadRequest['content_type'];
  purpose?: CreateUploadRequest['purpose'];
  /** Called as bytes go out, with the bytes sent so far in this PUT. A retried PUT starts again from 0. */
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  /** Cancels the upload. */
  signal?: AbortSignal;
}

/** A source that can be sent more than once, since a failed PUT is retried with the whole file. */
interface Replayable {
  size: number;
  open(): ReadableStream<Uint8Array>;
  close(): Promise<void>;
}

const nothing = async (): Promise<void> => {};

const bytesSource = (bytes: Uint8Array): Replayable => ({
  size: bytes.byteLength,
  close: nothing,
  open: () => {
    let offset = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(offset, offset + CHUNK_BYTES));
        offset += CHUNK_BYTES;
      },
    });
  },
});

const blobSource = (blob: Blob): Replayable => ({
  size: blob.size,
  close: nothing,
  open: () => blob.stream() as ReadableStream<Uint8Array>,
});

async function pathSource(path: string, onClose = nothing): Promise<Replayable> {
  const { open, stat } = await import('node:fs/promises');
  const { size } = await stat(path);
  const handles = new Set<Awaited<ReturnType<typeof open>>>();
  const release = async (file: Awaited<ReturnType<typeof open>>) => {
    handles.delete(file);
    await file.close();
  };
  return {
    size,
    // A runtime may never finish or cancel the stream of a PUT that storage answered early.
    close: async () => {
      await Promise.allSettled([...handles].map(release));
      await onClose();
    },
    open: () => {
      let file: Awaited<ReturnType<typeof open>> | undefined;
      return new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (!file) {
            file = await open(path, 'r');
            handles.add(file);
          }
          const buffer = new Uint8Array(CHUNK_BYTES);
          const { bytesRead } = await file.read(buffer, 0, CHUNK_BYTES, null);
          if (bytesRead === 0) {
            await release(file);
            controller.close();
          } else {
            controller.enqueue(buffer.subarray(0, bytesRead));
          }
        },
        async cancel() {
          if (file) await release(file);
        },
      });
    },
  };
}

/** A stream can be read only once and has no known size, so it is copied to a temporary file first. */
async function spool(stream: AsyncIterable<Uint8Array>): Promise<Replayable> {
  const [{ mkdtemp, rm, open }, { tmpdir }, { join }] = await Promise.all([
    import('node:fs/promises'),
    import('node:os'),
    import('node:path'),
  ]);
  const directory = await mkdtemp(join(tmpdir(), 'rask-upload-'));
  const remove = () => rm(directory, { recursive: true, force: true });
  try {
    const path = join(directory, 'source');
    const file = await open(path, 'w');
    try {
      for await (const chunk of stream) await file.write(chunk);
    } finally {
      await file.close();
    }
    return await pathSource(path, remove);
  } catch (error) {
    await remove();
    throw error;
  }
}

const sourceName = (source: UploadSource): string | undefined => {
  if (typeof source === 'string') return source.split(/[\\/]/).pop();
  if (source instanceof URL) return decodeURIComponent(source.pathname.split('/').pop() ?? '');
  if (typeof File !== 'undefined' && source instanceof File) return source.name;
  return undefined;
};

async function openSource(source: UploadSource): Promise<Replayable> {
  if (typeof source === 'string') return pathSource(source);
  if (source instanceof URL) {
    const { fileURLToPath } = await import('node:url');
    return pathSource(fileURLToPath(source));
  }
  if (source instanceof ArrayBuffer) return bytesSource(new Uint8Array(source));
  if (source instanceof Uint8Array) return bytesSource(source);
  if (typeof Blob !== 'undefined' && source instanceof Blob) return blobSource(source);
  const stream = source as Partial<ReadableStream<Uint8Array> & AsyncIterable<Uint8Array>>;
  if (typeof stream[Symbol.asyncIterator] === 'function') return spool(source as AsyncIterable<Uint8Array>);
  if (typeof stream.getReader === 'function') return spool(iterate(source as ReadableStream<Uint8Array>));
  throw new RaskConfigError({ message: 'uploadFile takes a path, a file URL, bytes, a Blob or a stream.' });
}

async function* iterate(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

interface PutResult {
  status: number | undefined;
  text: string;
  cause?: unknown;
}

/**
 * Deno's fetch sends a stream as chunked and drops the Content-Length the URL was signed for, so on Deno the PUT goes
 * through node:http. Node's and Bun's fetch keep it.
 */
async function putWithNodeHttp(url: string, headers: Headers, body: ReadableStream<Uint8Array>, signal: AbortSignal) {
  const { request } = await (url.startsWith('https:') ? import('node:https') : import('node:http'));
  const { default: EventEmitter } = await import('node:events');
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = request(url, { method: 'PUT', headers: Object.fromEntries(headers) });
    const fail = (error: unknown) => {
      req.destroy();
      reject(error);
    };
    signal.addEventListener('abort', () => fail(signal.reason), { once: true });
    req.on('error', reject);
    // Deno's node:http can close a dropped connection without an 'error' event. After a settled promise this does nothing.
    req.on('close', () => reject(new Error('The connection closed before a response arrived.')));
    req.on('response', (response) => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => {
        text += chunk;
      });
      response.on('end', () => resolve({ status: response.statusCode ?? 0, text }));
      response.on('error', reject);
    });
    (async () => {
      for await (const chunk of iterate(body)) {
        if (!req.write(chunk)) await EventEmitter.once(req, 'drain', { signal });
      }
      req.end();
    })().catch(fail);
  });
}

const isDeno = (): boolean => 'Deno' in globalThis;

const isExpired = (status: number | undefined, text: string): boolean =>
  status === 403 && /request has expired/i.test(text);

// 408, 429 and 5xx may pass on another try; any other answer from storage will not change.
const isTransientPut = (status: number | undefined): boolean =>
  status === undefined || status === 408 || status === 429 || status >= 500;

export class Uploads extends UploadsResource {
  /**
   * Uploads a file: createUpload, one PUT straight to storage without your API key, then completeUpload. A failed PUT
   * is retried up to 3 times with the whole file; an expired URL is signed again through getUpload. Multipart is not
   * in the API yet, so the file has to fit the plan's limit for one PUT.
   *
   * @param source A path, a file URL, bytes, a Blob or File, or a stream. A stream is copied to a temporary file first.
   * @returns The response of completeUpload: a `media_import` job. Pass its id to `jobs.wait`.
   */
  async uploadFile(source: UploadSource, options: UploadFileOptions = {}): Promise<RaskResponse<Job>> {
    // Checked first: a stream gets copied to disk, and only then would a missing name come to light.
    const filename = options.filename ?? sourceName(source);
    if (!filename) throw new RaskConfigError({ message: 'uploadFile needs filename for bytes and streams.' });
    const extension = filename.split('.').pop()?.toLowerCase() ?? '';
    const contentType = options.contentType ?? CONTENT_TYPES[extension];
    if (!contentType) {
      throw new RaskConfigError({ message: `uploadFile needs contentType: it cannot tell it from "${filename}".` });
    }
    const file = await openSource(source);
    try {
      const created = await this.createUpload({
        body: {
          filename,
          content_type: contentType,
          size_bytes: file.size,
          ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
        },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      });
      const uploadId = await this.#store(created.data, file, options);
      return (await this.completeUpload({
        path: { upload_id: uploadId },
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })) as RaskResponse<Job>;
    } finally {
      await file.close();
    }
  }

  async #store(created: Upload, file: Replayable, options: UploadFileOptions): Promise<string> {
    let upload = created;
    let failures = 0;
    let resigns = 0;
    const resign = async () => {
      resigns += 1;
      const signal = options.signal;
      const fresh = await this.getUpload({ path: { upload_id: upload.id }, ...(signal ? { signal } : {}) });
      upload = fresh.data;
    };
    for (;;) {
      const transfer = this.#transfer(upload);
      if (Date.parse(transfer.expires_at) <= Date.now() && resigns < MAX_RESIGNS) {
        await resign();
        continue;
      }
      const result = await this.#put(transfer, file, options);
      if (result.status !== undefined && result.status >= 200 && result.status < 300) return upload.id;
      if (isExpired(result.status, result.text) && resigns < MAX_RESIGNS) {
        await resign();
        continue;
      }
      if (!isTransientPut(result.status) || failures >= PUT_RETRIES) {
        const reason = result.status === undefined ? 'the connection failed' : `storage answered ${result.status}`;
        throw new UploadFailedError(upload.id, failures + 1, {
          status: result.status,
          body: result.text,
          cause: result.cause,
          message: `Upload ${upload.id}: ${reason} after ${failures + 1} PUTs; it was not completed.`,
        });
      }
      const wait = backoffMs(failures);
      failures += 1;
      this.transport.log(`retry ${failures} of the PUT of upload ${upload.id} in ${Math.round(wait)}ms`);
      await sleep(wait, options.signal);
    }
  }

  #transfer(upload: Upload): SingleUploadTransfer {
    const { transfer } = upload;
    if (!transfer) {
      throw new RaskError({ message: `Upload ${upload.id} has no transfer: the key needs media:write.` });
    }
    if (transfer.method !== 'single') {
      throw new RaskError({
        message: `Upload ${upload.id} uses the transfer method "${transfer.method}", which this SDK version cannot send.`,
      });
    }
    return transfer;
  }

  /** One PUT of the whole file. The timeout is on silence, since a large file takes longer than any fixed limit. */
  async #put(transfer: SingleUploadTransfer, file: Replayable, options: UploadFileOptions): Promise<PutResult> {
    const { transport } = this;
    const headers = new Headers(transfer.headers);
    headers.delete('Authorization');
    if (!headers.has('Content-Length')) headers.set('Content-Length', String(file.size));
    const idle = new AbortController();
    const idleMs = transport.timeoutSeconds * 1000;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ended = false;
    const touch = () => {
      clearTimeout(timer);
      // A runtime may go on reading the stream of a PUT that storage answered early. A timer started then would have
      // nobody to clear it, and would keep the process alive.
      if (ended) return;
      timer = setTimeout(() => idle.abort(new RaskTimeoutError({ message: 'The upload PUT stalled.' })), idleMs);
    };
    const signal = options.signal ? AbortSignal.any([idle.signal, options.signal]) : idle.signal;
    const url = transfer.url;
    let sent = 0;
    const counted = file.open().pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          sent += chunk.byteLength;
          touch();
          options.onProgress?.(sent, file.size);
        },
      }),
    );
    touch();
    transport.log(`> PUT ${transport.redactUrl(url)} authorization=none`);
    try {
      let result: { status: number; text: string };
      if (isDeno() && !transport.hasCustomFetch) {
        result = await putWithNodeHttp(url, headers, counted, signal);
      } else {
        const init = { method: 'PUT', headers, body: counted, duplex: 'half', signal } as RequestInit;
        const response = await transport.fetch(url, init);
        result = { status: response.status, text: await response.text() };
      }
      transport.log(`< ${result.status} PUT ${transport.redactUrl(url)}`);
      return result;
    } catch (cause) {
      if (options.signal?.aborted) throw options.signal.reason;
      transport.log(`< failed PUT ${transport.redactUrl(url)}`);
      // Some runtimes put the whole URL in their message, and this one's query is its signature.
      const reason = String(cause instanceof Error ? cause.message : cause).replaceAll(url, transport.redactUrl(url));
      return { status: undefined, text: '', cause: new Error(reason) };
    } finally {
      ended = true;
      clearTimeout(timer);
    }
  }
}
