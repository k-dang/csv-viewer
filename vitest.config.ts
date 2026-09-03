import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './packages/ui/src'),
    },
  },
  test: {
    exclude: [
      '**/dist-electron/**',
      '**/dist-renderer/**',
      '**/dist-web/**',
      '**/node_modules/**',
      'release/**',
    ],
    setupFiles: ['./vitest.setup.ts'],
    // Run contract files serially so CI has at most one memory-heavy DuckDB-Wasm worker.
    maxWorkers: 1,
  },
});
