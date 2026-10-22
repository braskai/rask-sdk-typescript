import * as sdk from '@braskai/rask-sdk';

import { runSmoke } from './smoke-checks.mjs';

await runSmoke(sdk, `esm ${globalThis.Deno ? 'deno' : globalThis.Bun ? 'bun' : `node ${process.version}`}`);
