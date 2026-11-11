// The loop of the harness's README, against this SDK: start a scenario, run its calls, check what only the client can see,
// then let the harness verify the wire. It takes the module under test, so it runs on src (Vitest) and on dist (Node, Bun,
// Deno).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { inspect } from 'node:util';

export const LANG = 'typescript';
const ENV_NAMES = ['RASK_API_KEY', 'RASK_BASE_URL', 'RASK_LOG'];

export const controlClient = (control) => {
  const send = async (method, path, body) => {
    const response = await fetch(`${control}${path}`, {
      method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const parsed = await response.json();
    if (response.status !== 200)
      throw new Error(`Control ${method} ${path}: ${response.status} ${JSON.stringify(parsed)}`);
    return parsed;
  };
  return {
    get: (path) => send('GET', path),
    post: (path, body = {}) => send('POST', path, body),
  };
};

const fillBytes = ({ size_bytes: size }) => Uint8Array.from({ length: size }, (_, index) => index % 256);

const operationCall = (rask, operations, op, params) => {
  const { group } = operations[op];
  return rask[group][op](params);
};

const paramsOf = (call) => {
  const params = {};
  if (call.path) params.path = call.path;
  if (call.query) params.query = call.query;
  if (call.body) params.body = call.body;
  if (call.if_match) params.ifMatch = call.if_match;
  if (call.idempotency_key) params.idempotencyKey = call.idempotency_key;
  return params;
};

async function runUpload(rask, call, scratch) {
  const bytes = fillBytes(call.content);
  const progress = [];
  const options = {
    filename: call.filename,
    contentType: call.content_type,
    onProgress: (sent) => progress.push(sent),
  };
  let source = Readable.from([Buffer.from(bytes)]);
  if (call.source === 'path') {
    source = join(scratch, call.filename);
    writeFileSync(source, bytes);
  }
  const result = await rask.uploads.uploadFile(source, options);
  return { ...result, progress };
}

async function runCall(rask, call, previous, sdk, harnessOperations, scratch) {
  const { OPERATIONS } = sdk;
  const params = paramsOf(call);
  if (call.op && !call.helper) return operationCall(rask, OPERATIONS, call.op, params);
  switch (call.helper) {
    case 'jobs.wait': {
      const jobId = call.job_id ?? previous[call.job_id_from_call].result.data.id;
      return rask.jobs.wait(jobId, call.timeout_seconds ? { timeoutSeconds: call.timeout_seconds } : {});
    }
    case 'uploads.upload_file':
      return runUpload(rask, call, scratch);
    case 'iterate': {
      const items = [];
      for await (const item of operationCall(rask, OPERATIONS, call.op, params)) items.push(item);
      return { items };
    }
    case 'first_page':
      return await operationCall(rask, OPERATIONS, call.op, params);
    case 'next_page':
      return await previous[call.after_call].result.nextPage();
    case 'sweep_operations': {
      const results = {};
      for (const operation of harnessOperations.filter((candidate) => candidate.has_json_response)) {
        const { path, query, headers, body } = operation.sample;
        const sample = { path, query };
        if (body !== null) sample.body = body;
        if (headers['If-Match']) sample.ifMatch = headers['If-Match'];
        const called = operationCall(rask, OPERATIONS, operation.operationId, sample);
        results[operation.operationId] = await called;
      }
      return { results };
    }
    default:
      throw new Error(`Unknown helper ${call.helper}`);
  }
}

const readPointer = (value, pointer) => {
  let node = value;
  for (const part of pointer.slice(1).split('/')) {
    if (node === null || typeof node !== 'object') return undefined;
    node = node[part.replaceAll('~1', '/').replaceAll('~0', '~')];
  }
  return node;
};

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const errorClasses = (error) => {
  const names = [];
  for (
    let proto = Object.getPrototypeOf(error);
    proto && proto !== Object.prototype;
    proto = Object.getPrototypeOf(proto)
  ) {
    names.push(proto.constructor.name);
  }
  return names;
};

function checkRaised(expectation, outcome, records) {
  const error = outcome?.error;
  if (!error) return ['expected an error, the call returned'];
  const failures = [];
  if (expectation.error_class && !errorClasses(error).includes(expectation.error_class)) {
    failures.push(`expected ${expectation.error_class}, got ${errorClasses(error).join(' < ')}`);
  }
  if (expectation.status !== undefined && error.status !== expectation.status) {
    failures.push(`expected status ${expectation.status}, got ${error.status} (${error.message})`);
  }
  if (expectation.code !== undefined && error.code !== expectation.code) {
    failures.push(`expected code ${expectation.code}, got ${error.code}`);
  }
  for (const [name, value] of Object.entries(expectation.fields ?? {})) {
    const actual = name === 'retry_after' ? error.retryAfter : error.problem?.[name];
    if (!same(actual, value)) failures.push(`expected ${name} ${JSON.stringify(value)}, got ${JSON.stringify(actual)}`);
  }
  for (const name of expectation.present ?? []) {
    if (error.problem?.[name] === undefined) failures.push(`expected ${name} on the error`);
  }
  if (expectation.request_id_matches_wire) {
    const known = records.some((record) => record.response?.headers['X-Request-Id'] === error.requestId);
    if (!known) failures.push(`requestId ${error.requestId} is not an X-Request-Id the server sent`);
  }
  return failures;
}

function checkHeader(expectation, outcome, records) {
  const source = outcome?.result ?? outcome?.error;
  const value = source?.headers?.get(expectation.name);
  if (value === null || value === undefined) return [`header ${expectation.name} is not exposed`];
  if (expectation.equals !== undefined && value !== expectation.equals) {
    return [`header ${expectation.name}: expected ${expectation.equals}, got ${value}`];
  }
  if (expectation.matches !== undefined && !new RegExp(expectation.matches).test(value)) {
    return [`header ${expectation.name}: ${value} does not match ${expectation.matches}`];
  }
  if (expectation.equals_field !== undefined && value !== readPointer(source.data, expectation.equals_field)) {
    return [`header ${expectation.name} differs from ${expectation.equals_field}`];
  }
  if (expectation.matches_wire && !records.some((record) => record.response?.headers[expectation.name] === value)) {
    return [`header ${expectation.name} ${value} is not what the server sent`];
  }
  return [];
}

function checkInjected(outcome, records) {
  const failures = [];
  const results = outcome?.result?.results ?? null;
  for (const record of records) {
    const injections = record.response?.injections ?? [];
    const body = results ? results[record.operationId]?.data : outcome?.result?.data;
    for (const injection of injections) {
      const actual = injection.pointer === '/' ? body : readPointer(body, injection.pointer);
      if (!same(actual, injection.value))
        failures.push(`${record.operationId} lost the ${injection.kind} at ${injection.pointer}`);
    }
  }
  if (!records.some((record) => record.response?.injections?.length)) failures.push('nothing was injected');
  return failures;
}

function checkLogs(expectation, run, records) {
  const logs = run.logs.join('\n');
  const failures = [];
  if (expectation.empty && logs !== '') failures.push(`expected no logs, got ${logs.slice(0, 200)}`);
  for (const text of expectation.must_contain ?? []) {
    if (!logs.includes(text)) failures.push(`logs do not contain ${text}`);
  }
  for (const text of expectation.must_not_contain ?? []) {
    if (logs.includes(text)) failures.push('logs contain a secret');
  }
  for (const { operationId, query } of expectation.must_not_contain_wire ?? []) {
    for (const record of records.filter((candidate) => candidate.operationId === operationId)) {
      if (logs.includes(record.raw_query_params[query])) failures.push(`logs contain ${query}`);
    }
  }
  return failures;
}

const CONFIG_FIELDS = {
  base_url: 'baseUrl',
  timeout_seconds: 'timeoutSeconds',
  'jobs.wait.timeout_seconds': 'waitTimeoutSeconds',
};

async function checkManual(scenario, sdk) {
  if (scenario.id === 'S17.browser-refused') {
    const { Rask } = sdk;
    const saved = { window: globalThis.window, document: globalThis.document };
    const failures = [];
    Object.assign(globalThis, { window: {}, document: {} });
    try {
      try {
        new Rask({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1/v3' });
        failures.push('constructed in a browser');
      } catch (error) {
        if (!String(error.message).includes('dangerouslyAllowBrowser'))
          failures.push(`the error says: ${error.message}`);
      }
      new Rask({ apiKey: 'k', baseUrl: 'http://127.0.0.1:1/v3', dangerouslyAllowBrowser: true });
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete globalThis[name];
        else globalThis[name] = value;
      }
    }
    return failures;
  }
  if (scenario.id === 'S14.language-markers') {
    const { readFile } = await import('node:fs/promises');
    const { renderResources } = await import('../../scripts/generate-resources.mjs');
    const spec = JSON.parse(await readFile(new URL('../../openapi/openapi.json', import.meta.url), 'utf8'));
    spec.paths['/me'].get.deprecated = true;
    const rendered = renderResources(spec);
    const before = rendered.slice(0, rendered.indexOf('  getMe('));
    const docblock = before.slice(before.lastIndexOf('/**'));
    return docblock.includes('@deprecated') ? [] : ['getMe has no @deprecated when the contract marks it'];
  }
  return [`no check for the manual scenario ${scenario.id}`];
}

async function checkExpectation(expectation, run, records, scenario, sdk) {
  const { rask, constructError, calls } = run;
  const outcome = calls[expectation.call ?? calls.length - 1];
  switch (expectation.kind) {
    case 'returned':
      return outcome && !outcome.error ? [] : [`call ${expectation.call} raised: ${outcome?.error?.message}`];
    case 'returned_or_raised':
      return [];
    case 'raised':
      return checkRaised(expectation, outcome, records);
    case 'raised_before_network': {
      const error = constructError ?? calls[0]?.error;
      if (!error) return ['expected an error before any request'];
      return error.message.includes(expectation.message_contains)
        ? []
        : [`error "${error.message}" does not mention ${expectation.message_contains}`];
    }
    case 'config': {
      if (!rask) return [`no client: ${constructError?.message}`];
      const actual = rask.config[CONFIG_FIELDS[expectation.field]];
      return same(actual, expectation.equals) ? [] : [`config ${expectation.field} is ${actual}`];
    }
    case 'repr_redacts': {
      if (!rask) return [`no client: ${constructError?.message}`];
      const texts = [String(rask), JSON.stringify(rask), inspect(rask, { showHidden: true, depth: 8 })];
      // The custom inspector could hide a key held by a field, so look through the fields too.
      texts.push(inspect({ ...rask }, { showHidden: true, depth: 8 }));
      return texts.some((text) => text.includes(expectation.secret))
        ? ['the key shows in the client representation']
        : [];
    }
    case 'field': {
      const result = outcome?.result;
      if (!result) return [`call raised: ${outcome?.error?.message}`];
      if (expectation.raw_status !== undefined && result.status !== expectation.raw_status)
        return [`status is ${result.status}`];
      if (expectation.path === undefined) return [];
      const value = readPointer(result.data, expectation.path);
      if (expectation.present) return value === undefined ? [`${expectation.path} is missing`] : [];
      return same(value, expectation.equals) ? [] : [`${expectation.path} is ${JSON.stringify(value)}`];
    }
    case 'header_exposed':
      return checkHeader(expectation, outcome, records);
    case 'idempotency_key_exposed': {
      const key = (outcome?.result ?? outcome?.error)?.idempotencyKey;
      if (!key) return ['the key is not exposed'];
      if (expectation.equals !== undefined && key !== expectation.equals) return [`key is ${key}`];
      if (expectation.matches_wire && !records.some((record) => record.headers['idempotency-key'] === key)) {
        return [`key ${key} was never sent`];
      }
      return [];
    }
    case 'items': {
      const items = outcome?.result?.items;
      if (!items) return [`no items: ${outcome?.error?.message}`];
      if (expectation.count !== undefined && items.length !== expectation.count) {
        return [`saw ${items.length} items, expected ${expectation.count}`];
      }
      if (
        expectation.ids &&
        !same(
          items.map((item) => item.id),
          expectation.ids,
        )
      ) {
        return [`saw ids ${items.map((item) => item.id)}`];
      }
      return [];
    }
    case 'pages': {
      const page = outcome?.result;
      if (!page) return [`no page: ${outcome?.error?.message}`];
      if (page.items.length !== expectation.item_count) return [`page has ${page.items.length} items`];
      return page.hasMore === expectation.has_more ? [] : [`hasMore is ${page.hasMore}`];
    }
    case 'warnings': {
      const failures =
        run.warnings.length === expectation.count
          ? []
          : [`saw ${run.warnings.length} warnings, expected ${expectation.count}`];
      for (const [name, count] of Object.entries(expectation.per_operation ?? {})) {
        const seen = run.warnings.filter((warning) => warning === name).length;
        if (seen !== count) failures.push(`${name}: saw ${seen} warnings, expected ${count}`);
      }
      return failures;
    }
    case 'progress':
      return outcome?.result?.progress?.at(-1) === expectation.final_bytes
        ? []
        : ['onProgress did not reach the file size'];
    case 'logs':
      return checkLogs(expectation, run, records);
    case 'injected_values_preserved':
      return checkInjected(outcome, records);
    case 'manual':
      return checkManual(scenario, sdk);
    default:
      throw new Error(`Unknown expectation ${expectation.kind}`);
  }
}

export async function runScenario(control, id, sdk) {
  const scenario = await control.post(`/scenarios/${id}/start`, { lang: LANG });
  const { operations } = await control.get('/operations');
  const saved = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
  for (const name of ENV_NAMES) delete process.env[name];
  Object.assign(process.env, scenario.client.env);
  const scratch = mkdtempSync(join(tmpdir(), 'rask-acceptance-'));
  const run = { rask: null, constructError: null, calls: [], logs: [], warnings: [] };
  try {
    const args = scenario.client.args;
    try {
      const options = {
        logger: (line) => run.logs.push(line),
        onDeprecation: (notice) => run.warnings.push(notice.operationId),
      };
      if (args.api_key !== undefined) options.apiKey = args.api_key;
      if (args.base_url !== undefined) options.baseUrl = args.base_url;
      if (args.timeout_seconds !== undefined) options.timeoutSeconds = args.timeout_seconds;
      run.rask = new sdk.Rask(options);
    } catch (error) {
      run.constructError = error;
    }
    if (run.rask) {
      for (const call of scenario.calls) {
        try {
          run.calls.push({ result: await runCall(run.rask, call, run.calls, sdk, operations, scratch) });
        } catch (error) {
          run.calls.push({ error });
        }
      }
    }
    const { requests } = await control.get('/requests');
    const failures = [];
    for (const expectation of scenario.expect_sdk) {
      failures.push(...(await checkExpectation(expectation, run, requests, scenario, sdk)));
    }
    const verify = await control.post(`/scenarios/${id}/verify`, {
      lang: LANG,
      sdk_passed: failures.length === 0,
      sdk_detail: failures.join('; '),
    });
    return { id, pass: verify.pass, failures: verify.failures, requests: verify.requests };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
    for (const name of ENV_NAMES) delete process.env[name];
    for (const [name, value] of Object.entries(saved)) {
      if (value !== undefined) process.env[name] = value;
    }
  }
}

/** The ids to run in this language. `slow` adds the two scenarios that take minutes. */
export async function scenarioIds(control, { slow = false } = {}) {
  const { scenarios } = await control.get(`/scenarios?lang=${LANG}`);
  return scenarios
    .filter((scenario) => scenario.applies && (slow || !scenario.slow) && scenario.status !== 'later')
    .map((s) => s.id);
}
