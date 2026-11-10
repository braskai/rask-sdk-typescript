import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { dub } from '../examples/quickstart';
import { Rask } from '../src/index';
import { type RecordedRequest, useHarness } from './helpers';

const run = promisify(execFile);
const scratch = mkdtempSync(join(tmpdir(), 'rask-example-test-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

describe('the worked example', () => {
  const harness = useHarness();
  beforeEach(() => harness.control.post('/reset'));

  it('runs against the contract: upload, createProject, jobs.wait, download', async () => {
    const input = join(scratch, 'talk.mp4');
    writeFileSync(input, new Uint8Array(1024));
    const output = join(scratch, 'dubbed.mp4');
    await harness.control.post('/jobs', { id: 'job-import', type: 'media_import', states: ['succeeded'] });
    await harness.control.post('/script', { operationId: 'completeUpload', steps: [{ job: 'job-import' }] });
    // The contract's example of an output has a URL on a host of its own. Only that download is answered here.
    const realFetch = globalThis.fetch;
    const stub = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      if (new URL(target).hostname === '127.0.0.1' || new URL(target).hostname === 'localhost') {
        return realFetch(url, init);
      }
      return Promise.resolve(new Response('video-bytes'));
    });
    vi.stubGlobal('fetch', stub);
    try {
      const rask = new Rask({ apiKey: harness.apiKey, baseUrl: harness.baseUrl });
      const seen = vi.spyOn(console, 'log').mockImplementation(() => {});
      await dub(rask, input, 'es-es', output);
      seen.mockRestore();
    } finally {
      vi.unstubAllGlobals();
    }
    expect(readFileSync(output, 'utf8')).toBe('video-bytes');
    const recorded = (await harness.requests()) as RecordedRequest[];
    expect(recorded.flatMap((request) => request.violations)).toEqual([]);
    expect(recorded.map((request) => request.operationId)).toEqual([
      'createUpload',
      '__storage_put',
      'completeUpload',
      'getJob',
      'estimateProject',
      'createProject',
      'getJob',
      'listProjectOutputs',
    ]);
  });

  it('is what the README shows', () => {
    const source = readFileSync('examples/quickstart.ts', 'utf8');
    const example = source.slice(source.indexOf('// BEGIN README\n') + 16, source.indexOf('// END README'));
    expect(readFileSync('README.md', 'utf8')).toContain(example);
  });
});

const hasBuild = existsSync('dist/index.mjs');

describe.runIf(hasBuild)('examples/smoke', () => {
  const harness = useHarness();

  it('walks the calls, one line each, with no secrets', async () => {
    await harness.control.post('/reset');
    await harness.control.post('/pages', { operationId: 'listProjects', pages: 2, page_size: 2 });
    const env = { ...process.env, RASK_API_KEY: harness.apiKey, RASK_BASE_URL: harness.baseUrl };
    const { stdout } = await run('node', ['examples/smoke/smoke.mjs'], { env });
    const names = stdout
      .trim()
      .split('\n')
      .filter((line) => line.startsWith('ok '))
      .map((line) => line.split(' status=')[0]?.replace('ok   ', ''));
    expect(names).toEqual([
      'getMe',
      'listLanguages',
      'listVoices ru-ru',
      'listProjects page 1',
      'listProjects page 2',
      'getBalance',
      'getPlan',
      'createFolder',
      'getFolder',
      'deleteFolder',
    ]);
    expect(stdout).toContain('smoke ok');
    expect(stdout).not.toContain(harness.apiKey);
    const recorded = (await harness.requests()) as RecordedRequest[];
    expect(recorded.flatMap((request) => request.violations)).toEqual([]);
  });

  it('refuses to start without its two variables', async () => {
    const env: NodeJS.ProcessEnv = { ...process.env, RASK_API_KEY: 'x' };
    delete env.RASK_BASE_URL;
    await expect(run('node', ['examples/smoke/smoke.mjs'], { env })).rejects.toMatchObject({ code: 2 });
  });
});
