import { expect, test } from '@playwright/test';
import { openCsv } from './helpers/csv';

test('cancels a held refresh, preserves the previous result, and can retry', { tag: '@dev' }, async ({ page }) => {
  // Hold the next cancellable driver operation. The real comparison lifecycle and UI
  // still run; interruption removes the gate instead of depending on machine speed.
  await page.route((url) => url.pathname === '/src/duckdb-wasm-database.ts', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const anchor = 'return Effect.suspend(() => {';
    expect(source).toContain(anchor);
    await route.fulfill({ response, body: source.replace(anchor, `
      if (document.body.dataset.holdComparison === 'true') {
        delete document.body.dataset.holdComparison;
        return Effect.callback((resume) => {
          const release = () => resume(this.readObjectsCancellable(sql, values));
          window.addEventListener('release-comparison', release, { once: true });
          return Effect.sync(() => window.removeEventListener('release-comparison', release));
        });
      }
      ${anchor}
    `) });
  });
  await page.goto('/');
  await openCsv(page, 'baseline.csv', 'id,value\n1,Ada\n');
  await openCsv(page, 'candidate.csv', 'id,value\n1,Grace\n');
  await page.getByRole('button', { name: 'Compare…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose a Candidate' }).getByRole('button', { name: /baseline.csv/ }).click();
  await page.getByRole('checkbox', { name: 'id', exact: true }).check();
  await page.getByRole('button', { name: 'Apply key', exact: true }).click();
  await expect(page.getByText('Changed 1', { exact: true })).toBeVisible();
  await page.evaluate(() => { document.body.dataset.holdComparison = 'true'; });
  await page.getByRole('button', { name: 'Refresh comparison', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit key', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Swap sides', exact: true })).toBeDisabled();
  await expect(page.getByText('Changed 1', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByText('Comparison cancelled. The previous applied result was preserved.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Selected comparison row' }).getByRole('cell', { name: /candidate changed value: Ada/ })).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.getByRole('button', { name: 'Refresh comparison', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh comparison', exact: true })).toBeEnabled();
  await expect(page.getByText('Changed 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Comparison cancelled.', { exact: false })).toHaveCount(0);
});
