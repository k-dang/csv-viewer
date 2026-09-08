import { defineConfig } from '@playwright/test';

const baseURL = 'http://127.0.0.1:4173';

export default defineConfig({
  testDir: './e2e',
  use: {
    browserName: 'chromium',
    baseURL,
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'pnpm --filter @csv-viewer/web dev --host 127.0.0.1 --port 4173 --strictPort',
    url: baseURL,
  },
});
