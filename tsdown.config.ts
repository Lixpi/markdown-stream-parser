import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/markdown-stream-parser.ts'],
  dts: true,
  format: ['esm', 'cjs'],
  minify: true,
  outDir: 'build',
  clean: true,
  sourcemap: false,
  target: 'es2015',
})
