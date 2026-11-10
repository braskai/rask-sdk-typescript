#!/usr/bin/env node
// openapi/openapi.json + openapi/sdk-fallback.yaml -> src/generated/. Run it with `npm run generate`.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse } from 'yaml';

import { renderResources } from './generate-resources.mjs';
import { applyOverlay } from './overlay.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const at = (path) => join(root, path);

const spec = JSON.parse(readFileSync(at('openapi/openapi.json'), 'utf8'));
applyOverlay(spec, parse(readFileSync(at('openapi/sdk-fallback.yaml'), 'utf8')));
writeFileSync(at('openapi/openapi.sdk.json'), `${JSON.stringify(spec, null, 2)}\n`);

rmSync(at('src/generated'), { recursive: true, force: true });
execFileSync(join(root, 'node_modules/.bin/openapi-ts'), { cwd: root, stdio: 'inherit' });

// TypeScript would reduce `AKnown | string` to `string`. `string & {}` keeps it open and keeps the known values in editors.
const typesPath = at('src/generated/types.gen.ts');
const types = readFileSync(typesPath, 'utf8');
const open = types.replace(/^(export type \w+ = \w+Known) \| string;$/gm, '$1 | (string & {});');
writeFileSync(typesPath, open);

writeFileSync(at('src/generated/resources.gen.ts'), renderResources(spec));
