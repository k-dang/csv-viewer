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
    // Native DuckDB tests exceed their timeout when too many transform workers compete for CPU.
    maxWorkers: 4,
  },
});
