import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  // node: built-ins are imported lazily, only by uploadFile on a path or a Node stream.
  platform: 'neutral',
  target: 'es2022',
  dts: true,
  fixedExtension: true,
  clean: true,
  external: [/^node:/],
});
