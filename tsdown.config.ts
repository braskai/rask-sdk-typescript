import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  // No Node built-ins are used: the bundle runs on Node >= 18, Bun, Deno, edge runtimes and browsers.
  platform: 'neutral',
  target: 'es2022',
  dts: true,
  // Always emit index.mjs / index.cjs (+ .d.mts / .d.cts).
  fixedExtension: true,
  clean: true,
});
