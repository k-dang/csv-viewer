import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/renderer'),
    },
  },
  test: {
    exclude: ['dist-electron/**', 'dist-renderer/**', 'node_modules/**', 'release/**'],
    setupFiles: ['./vitest.setup.ts'],
    // Run contract files serially so CI has at most one memory-heavy DuckDB-Wasm worker.
    maxWorkers: 1,
  },
});
