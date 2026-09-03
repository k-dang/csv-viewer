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
    // Matches the CI runner's core count; more workers stop paying for themselves past it.
    maxWorkers: 4,
  },
});
