import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { collectOperations, renderResources } from '../scripts/generate-resources.mjs';
import { applyOverlay, parseTarget } from '../scripts/overlay.mjs';
import { VERSION } from '../src/index';

const contract = () => JSON.parse(readFileSync('openapi/openapi.json', 'utf8'));
const overlay = () => parse(readFileSync('openapi/sdk-fallback.yaml', 'utf8'));

describe('the overlay', () => {
  it('understands the targets it uses and refuses others', () => {
    expect(parseTarget("$.paths['/a/{b}'].get.parameters[6].schema")).toEqual([
      'paths',
      '/a/{b}',
      'get',
      'parameters',
      6,
      'schema',
    ]);
    expect(() => parseTarget('$.paths[*].get')).toThrow('Unsupported');
    expect(() => parseTarget('$..x')).toThrow('Unsupported');
  });

  it('fails on a target that is not there', () => {
    expect(() =>
      applyOverlay({ components: {} }, { actions: [{ target: '$.components.schemas', update: {} }] }),
    ).toThrow('not found');
  });

  it('opens response enums, closes request ones, and makes the key optional', () => {
    const spec = applyOverlay(contract(), overlay());
    expect(spec.components.schemas.JobStatus.anyOf).toEqual([
      { $ref: '#/components/schemas/JobStatusKnown' },
      { type: 'string' },
    ]);
    expect(spec.components.parameters.IdempotencyKey.required).toBe(false);
  });
});

describe('the generated code', () => {
  it('has one method per operation, named after its operationId', () => {
    const operations = collectOperations(contract());
    expect(operations).toHaveLength(82);
    expect(new Set(operations.map((operation: { id: string }) => operation.id)).size).toBe(82);
    expect(renderResources(contract())).toBe(renderResources(contract()));
  });

  it('marks an operation the contract deprecates, and only that one', () => {
    const spec = contract();
    expect(renderResources(spec)).not.toContain('@deprecated');
    spec.paths['/me'].get.deprecated = true;
    const rendered = renderResources(spec);
    expect(rendered.match(/@deprecated/g)).toHaveLength(1);
    const docblock = rendered.slice(
      rendered.lastIndexOf('/**', rendered.indexOf('  getMe(')),
      rendered.indexOf('  getMe('),
    );
    expect(docblock).toContain('@deprecated');
  });

  it('keeps open enums open and their known values visible', () => {
    const types = readFileSync('src/generated/types.gen.ts', 'utf8');
    expect(types).toContain('export type JobStatus = JobStatusKnown | (string & {});');
  });
});

describe('the version', () => {
  it('is the package version', () => {
    expect(VERSION).toBe(JSON.parse(readFileSync('package.json', 'utf8')).version);
  });
});
