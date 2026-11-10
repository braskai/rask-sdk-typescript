import { defineConfig } from '@hey-api/openapi-ts';

export default defineConfig({
  // openapi.json with sdk-fallback.yaml applied; scripts/generate.mjs writes it.
  input: './openapi/openapi.sdk.json',
  output: {
    path: './src/generated',
    clean: false,
  },
  plugins: [
    // Errors are mapped by the hand-written layer, so the generated client never throws.
    { name: '@hey-api/client-fetch', throwOnError: false },
    '@hey-api/typescript',
    { name: '@hey-api/sdk', operations: { strategy: 'flat' } },
  ],
});
