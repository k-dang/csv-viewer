import { expect, test } from '@playwright/test';
import { beforeWorkspaceStarts, openCsv } from './helpers/csv';

test('preserves focus after failed cancellation, restores it after success, and can retry', { tag: '@dev' }, async ({ page }) => {
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
      if (document.body.dataset.failComparison === 'true') {
        delete document.body.dataset.failComparison;
        return Effect.fail(new DataEngineError({ cause: new Error('Injected comparison failure') }));
      }
      ${anchor}
    `) });
  });
  await beforeWorkspaceStarts(page, `
    const call = started.viewer.call.bind(started.viewer);
    started.viewer.call = async (request) => {
      if (request.operation === 'comparison.cancel' && document.body.dataset.rejectCancel === 'true') {
        delete document.body.dataset.rejectCancel;
        throw new Error('Unable to cancel comparison.');
      }
      return call(request);
    };
  `);
  await page.goto('/');
  await openCsv(page, 'baseline.csv', 'id,value\n1,Ada\n');
  await openCsv(page, 'candidate.csv', 'id,value\n1,Grace\n');
  await page.getByRole('button', { name: 'Compare…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose a Candidate' }).getByRole('button', { name: /baseline.csv/ }).click();
  await page.getByRole('checkbox', { name: 'id', exact: true }).check();
  await page.getByRole('button', { name: 'Apply key', exact: true }).click();
  await expect(page.getByText('Changed 1', { exact: true })).toBeVisible();
  const comparison = page.getByRole('region', { name: 'CSV comparison', exact: true });
  const body = comparison.locator('.comparison-result-body');
  const before = await body.boundingBox();
  const refreshWidth = (await page.getByRole('button', { name: 'Refresh comparison', exact: true }).boundingBox())?.width;
  await page.evaluate(() => {
    document.body.dataset.holdComparison = 'true';
    document.body.dataset.rejectCancel = 'true';
  });
  await page.getByRole('button', { name: 'Refresh comparison', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(comparison.getByRole('alert')).toHaveText('Unable to cancel comparison.');
  const search = comparison.getByRole('searchbox', { name: 'Find a comparison row or value' });
  await search.focus();
  await page.evaluate(() => window.dispatchEvent(new Event('release-comparison')));
  await expect(page.getByRole('button', { name: 'Refresh comparison', exact: true })).toBeEnabled();
  await expect(search).toBeFocused();
  await page.evaluate(() => { document.body.dataset.holdComparison = 'true'; });
  await page.getByRole('button', { name: 'Refresh comparison', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Edit key', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Swap sides', exact: true })).toBeDisabled();
  await expect(page.getByText('Changed 1', { exact: true })).toBeVisible();
  const refreshing = page.getByRole('button', { name: 'Refreshing…', exact: true });
  await expect(refreshing).toBeDisabled();
  expect((await refreshing.boundingBox())?.width).toBe(refreshWidth);
  expect(await body.boundingBox()).toEqual(before);
  await expect(page.getByText('The current result remains readable until its replacement is ready.')).toHaveCount(0);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByText('Comparison cancelled. The previous applied result was preserved.')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Selected comparison row' }).getByRole('cell', { name: /candidate changed value: Ada/ })).toBeVisible();
  expect(await body.boundingBox()).toEqual(before);
  await expect(page.getByRole('button', { name: 'Refresh comparison', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await page.evaluate(() => { document.body.dataset.failComparison = 'true'; });
  await page.getByRole('button', { name: 'Refresh comparison', exact: true }).click();
  await expect(comparison.getByRole('alert')).toContainText('Comparison failed.');
  await expect(comparison.getByRole('cell', { name: /candidate changed value: Ada/ })).toBeVisible();
  expect(await body.boundingBox()).toEqual(before);
  await comparison.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(comparison.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Refresh comparison', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Refresh comparison', exact: true })).toBeEnabled();
  await expect(page.getByText('Changed 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Comparison cancelled.', { exact: false })).toHaveCount(0);
});
