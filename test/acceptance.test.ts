// The shared acceptance suite (S1-S17, BU1-BU7) over real HTTP, on a custom base URL with a path prefix.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as sdk from '../src/index';
import { findHarness } from './acceptance/harness.mjs';
import { LANG, runScenario } from './acceptance/runner.mjs';
import { useHarness } from './helpers';

const slow = process.env.RUN_SLOW === '1';
const list = JSON.parse(readFileSync(join(dirname(findHarness()), '../scenarios/scenarios.json'), 'utf8'));
const ids: string[] = list.scenarios
  .filter(
    (scenario: { status?: string; slow?: boolean; languages?: string[] }) =>
      scenario.status !== 'later' && (slow || !scenario.slow) && (scenario.languages ?? [LANG]).includes(LANG),
  )
  .map((scenario: { id: string }) => scenario.id);

describe('acceptance', () => {
  const harness = useHarness();

  it.each(ids)(
    '%s',
    async (id) => {
      const result = await runScenario(harness.control, id, sdk);
      expect(result.failures).toEqual([]);
      expect(result.pass).toBe(true);
    },
    150_000,
  );

  it('leaves nothing out', async () => {
    const report = await harness.control.get(`/report?lang=${LANG}${slow ? '&slow=true' : ''}`);
    expect(report.failed).toEqual([]);
    expect(report.not_run).toEqual([]);
    expect(report.complete).toBe(true);
  });
});
