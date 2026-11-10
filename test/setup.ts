import { guardFetch } from './acceptance/harness.mjs';

// The default base URL is production: no test may reach it, whatever goes wrong.
guardFetch();
