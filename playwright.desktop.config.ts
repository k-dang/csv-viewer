import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e/desktop',
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  use: { screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  outputDir: 'test-results/desktop',
});
