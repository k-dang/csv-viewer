import { defineConfig } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: './e2e',
  testIgnore: ['desktop/**'],
  workers: 2,
  forbidOnly: Boolean(process.env.CI),
  use: {
    browserName: 'chromium',
    baseURL,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium' }],
  webServer: {
    command: 'pnpm --filter @csv-viewer/web dev --host 127.0.0.1 --port 4173 --strictPort',
    url: baseURL,
  },
});
