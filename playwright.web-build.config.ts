import { defineConfig } from '@playwright/test';

// Reuse the engine failure/recovery cases against emitted assets. Navigation's source
// instrumentation belongs to the dev-server suite.
export default defineConfig({
  testDir: './e2e',
  testMatch: 'web-lifecycle.spec.ts',
  grep: /cannot load|Worker failure/,
  use: { browserName: 'chromium', baseURL: 'http://127.0.0.1:4174' },
  outputDir: 'test-results/web-build',
  webServer: {
    command: 'pnpm run build:web && pnpm --filter @csv-viewer/web exec vite preview --host 127.0.0.1 --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174',
  },
});
