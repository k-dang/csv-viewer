import { defineConfig } from '@playwright/test';

// Run user workflows against emitted assets, excluding cases that instrument Vite source.
export default defineConfig({
  testDir: './e2e',
  testIgnore: ['desktop/**'],
  grepInvert: /@dev/,
  workers: 2,
  forbidOnly: Boolean(process.env.CI),
  use: { browserName: 'chromium', baseURL: 'http://127.0.0.1:4174', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  outputDir: 'test-results/web-build',
  webServer: {
    command: 'pnpm run build:web && pnpm --filter @csv-viewer/web exec vite preview --host 127.0.0.1 --port 4174 --strictPort',
    url: 'http://127.0.0.1:4174',
  },
});
