#!/usr/bin/env node
// Runs every scenario against the built package, on whichever runtime runs this file (Node, Bun or Deno).
// RUN_SLOW=1 adds the two slow scenarios (about three minutes more). Ids as arguments run only those.
import * as sdk from '../../dist/index.mjs';
import { guardFetch, startHarness } from './harness.mjs';
import { controlClient, LANG, runScenario, scenarioIds } from './runner.mjs';

guardFetch();
const slow = process.env.RUN_SLOW === '1';
const harness = await startHarness();
let failed = 0;
try {
  const control = controlClient(harness.control);
  const only = process.argv.slice(2);
  const ids = only.length > 0 ? only : await scenarioIds(control, { slow });
  for (const id of ids) {
    const started = Date.now();
    const result = await runScenario(control, id, sdk);
    if (!result.pass) failed += 1;
    const label = result.pass ? 'ok  ' : 'FAIL';
    console.log(
      `${label} ${id} (${Date.now() - started} ms)${result.pass ? '' : ` ${JSON.stringify(result.failures)}`}`,
    );
  }
  const report = await control.get(`/report?lang=${LANG}${slow ? '&slow=true' : ''}`);
  const summary = {
    passed: report.passed?.length,
    failed: report.failed?.length,
    not_run: report.not_run,
    slow_not_run: report.slow_not_run,
    complete: report.complete,
  };
  console.log(JSON.stringify(summary));
  if (failed > 0 || (only.length === 0 && !report.complete)) process.exitCode = 1;
} finally {
  harness.stop();
}
// A child process and open handles must not keep Deno or Bun alive.
process.exit(process.exitCode ?? 0);
