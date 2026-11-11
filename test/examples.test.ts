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

  // A project_processing job whose result says what became of the auto-dub.
  const projectResult = (autoDub: Record<string, unknown>) => ({
    type: 'project_processing',
    project_id: 'project-1',
    source_language: 'en-us',
    speakers_detected: 1,
    subtitles_imported: { source: false, target: false },
    copy_of_project_id: null,
    reused_dub: false,
    auto_dub: autoDub,
    onscreen_auto_start: { state: 'not_requested', rejection_code: null },
    localization_job_id: null,
    notices: [],
  });

  async function script(autoDub: Record<string, unknown>) {
    await harness.control.post('/jobs', { id: 'job-import', type: 'media_import', states: ['succeeded'] });
    await harness.control.post('/script', { operationId: 'completeUpload', steps: [{ job: 'job-import' }] });
    await harness.control.post('/jobs', {
      id: 'job-project',
      type: 'project_processing',
      states: ['running', 'succeeded'],
      result: projectResult(autoDub),
    });
    await harness.control.post('/script', { operationId: 'createProject', steps: [{ job: 'job-project' }] });
    await harness.control.post('/jobs', { id: 'job-dub', type: 'dub', states: ['running', 'succeeded'] });
  }

  // The contract's example of an output has a URL on a host of its own. Only that download is answered here.
  async function runDub(input: string, output: string) {
    const realFetch = globalThis.fetch;
    const stub = vi.fn((url: RequestInfo | URL, init?: RequestInit) => {
      const target = String(url);
      if (new URL(target).hostname === '127.0.0.1' || new URL(target).hostname === 'localhost') {
        return realFetch(url, init);
      }
      return Promise.resolve(new Response('video-bytes'));
    });
    vi.stubGlobal('fetch', stub);
    const seen = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const rask = new Rask({ apiKey: harness.apiKey, baseUrl: harness.baseUrl });
      return await dub(rask, input, 'es-es', output);
    } finally {
      seen.mockRestore();
      vi.unstubAllGlobals();
    }
  }

  function newInput(name: string) {
    const input = join(scratch, name);
    writeFileSync(input, new Uint8Array(1024));
    return input;
  }

  it('runs against the contract: upload, estimate, createProject, waits for the project and the dub, download', async () => {
    const input = newInput('talk.mp4');
    const output = join(scratch, 'dubbed.mp4');
    await script({ state: 'dispatched', skipped_reason: null, dub_job_id: 'job-dub' });

    await expect(runDub(input, output)).resolves.toEqual({ projectId: 'project-1', outputPath: output });

    expect(readFileSync(output, 'utf8')).toBe('video-bytes');
    const recorded = (await harness.requests()) as RecordedRequest[];
    expect(recorded.flatMap((request) => request.violations)).toEqual([]);
    // The scripted job results are valid by the contract too.
    expect(recorded.flatMap((request) => request.response?.self_check ?? [])).toEqual([]);
    expect(recorded.map((request) => request.operationId)).toEqual([
      'createUpload',
      '__storage_put',
      'completeUpload',
      'getJob',
      'estimateProject',
      'createProject',
      'getJob',
      'getJob',
      'getJob',
      'getJob',
      'listProjectOutputs',
    ]);
    const waited = recorded.filter((request) => request.operationId === 'getJob').map((request) => request.path);
    expect(waited.slice(1).map((path) => path.split('/').at(-1))).toEqual([
      'job-project',
      'job-project',
      'job-dub',
      'job-dub',
    ]);
    // The key it sent is the one it saved, so that a run started again sends the same one.
    const saved = JSON.parse(readFileSync(`${input}.es-es.json`, 'utf8'));
    const create = recorded.find((request) => request.operationId === 'createProject');
    expect(create?.headers['idempotency-key']).toBe(saved.createKey);
    expect(saved).toMatchObject({ projectJobId: 'job-project', maxMinutes: expect.any(Number) });
  });

  it('started again, goes on from what it saved: no second upload and no second project', async () => {
    const input = newInput('again.mp4');
    const output = join(scratch, 'again.es.mp4');
    await script({ state: 'dispatched', skipped_reason: null, dub_job_id: 'job-dub' });
    await runDub(input, output);
    const before = (await harness.requests()).length;
    rmSync(output);

    await runDub(input, output);

    expect(readFileSync(output, 'utf8')).toBe('video-bytes');
    const recorded = ((await harness.requests()) as RecordedRequest[]).slice(before);
    expect(recorded.map((request) => request.operationId)).toEqual(['getJob', 'getJob', 'listProjectOutputs']);
  });

  it('stopped before it saved the project job, sends createProject again with the same key', async () => {
    const input = newInput('lost.mp4');
    const output = join(scratch, 'lost.es.mp4');
    await script({ state: 'dispatched', skipped_reason: null, dub_job_id: 'job-dub' });
    await runDub(input, output);
    const progressPath = `${input}.es-es.json`;
    const { projectJobId: _, ...beforeTheAnswer } = JSON.parse(readFileSync(progressPath, 'utf8'));
    writeFileSync(progressPath, JSON.stringify(beforeTheAnswer));
    await harness.control.post('/script', { operationId: 'createProject', steps: [{ job: 'job-project' }] });
    const before = (await harness.requests()).length;

    await runDub(input, output);

    const recorded = ((await harness.requests()) as RecordedRequest[]).slice(before);
    expect(recorded.map((request) => request.operationId)).toEqual([
      'createProject',
      'getJob',
      'getJob',
      'listProjectOutputs',
    ]);
    expect(recorded[0]?.headers['idempotency-key']).toBe(beforeTheAnswer.createKey);
  });

  it('stops before the download when the auto-dub was skipped, and says what to do', async () => {
    const input = newInput('skipped.mp4');
    const output = join(scratch, 'skipped.es.mp4');
    await script({ state: 'skipped', skipped_reason: 'cost_changed', dub_job_id: null });

    await expect(runDub(input, output)).rejects.toThrow(
      /Project project-1 was not dubbed: auto_dub is skipped \(cost_changed\)\. Call estimateDub, then createDub/,
    );

    expect(existsSync(output)).toBe(false);
    const recorded = (await harness.requests()) as RecordedRequest[];
    expect(recorded.map((request) => request.operationId)).not.toContain('listProjectOutputs');
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
