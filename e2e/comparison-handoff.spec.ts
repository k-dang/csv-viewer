import { expect, test, type Page } from '@playwright/test';
import { beforeWorkspaceStarts, editCell, openCsv } from './helpers/csv';

declare global {
  interface Window {
    comparisonFrames: string[];
  }
}

/** Holds delivery at the viewer boundary; the real comparison and row query still run. */
async function holdFirstWindow(page: Page): Promise<void> {
  await beforeWorkspaceStarts(page, `
    const call = started.viewer.call.bind(started.viewer);
    started.viewer.call = async (request) => {
      const outcome = await call(request);
      if (request.operation === 'comparison.get-window') {
        if (document.body.dataset.failFirstWindow === 'true') {
          delete document.body.dataset.failFirstWindow;
          throw new Error('Injected first-window delivery failure');
        }
        if (document.body.dataset.holdFirstWindow === 'true') {
          document.body.dataset.firstWindowHeld = 'true';
          await new Promise(resolve => window.addEventListener('release-first-window', resolve, { once: true }));
        }
      }
      return outcome;
    };
  `);
}

async function openComparison(page: Page): Promise<void> {
  await page.goto('/');
  await openCsv(page, 'baseline.csv', 'id,value\n1,Old\n2,Same\n');
  await openCsv(page, 'candidate.csv', 'id,value\n1,New\n2,Same\n');
  await page.getByRole('tab', { name: 'baseline.csv', exact: true }).click();
  await page.getByRole('button', { name: 'Compare…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose a Candidate' }).getByRole('button', { name: /candidate.csv/ }).click();
  await page.getByRole('checkbox', { name: 'id', exact: true }).check();
}

async function releaseWindow(page: Page): Promise<void> {
  await page.evaluate(() => {
    delete document.body.dataset.holdFirstWindow;
    delete document.body.dataset.firstWindowHeld;
    window.dispatchEvent(new Event('release-first-window'));
  });
}

test('hands off from the key form to a complete first result without intermediate screens', { tag: '@dev' }, async ({ page }, testInfo) => {
  await holdFirstWindow(page);
  await openComparison(page);
  await page.evaluate(() => {
    document.body.dataset.holdFirstWindow = 'true';
    const samples: string[] = [];
    window.comparisonFrames = samples;
    const sample = () => {
      samples.push(document.querySelector('[aria-label="CSV comparison"]')?.textContent ?? '');
      if (!document.body.dataset.stopComparisonFrames) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  await page.getByRole('button', { name: 'Apply key', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-first-window-held', 'true');
  const comparison = page.getByRole('region', { name: 'CSV comparison', exact: true });
  await expect(comparison.getByRole('heading', { name: 'Choose a Comparison Key', exact: true })).toBeVisible();
  await expect(comparison.getByText('Match rows by', { exact: true })).toHaveCount(0);
  await expect(comparison.getByRole('button', { name: 'Apply key', exact: true })).toBeDisabled();
  await expect(comparison.getByRole('status')).toContainText('Comparing CSVs…');
  await page.screenshot({ path: testInfo.outputPath('waiting-first-window.png') });
  await releaseWindow(page);
  await expect(comparison.getByRole('region', { name: 'Selected comparison row' }).getByRole('cell', { name: /candidate changed value: New/ })).toBeVisible();
  await expect(comparison.getByRole('grid', { name: 'Comparison rows' }).getByRole('gridcell', { name: /id 1/ })).toBeVisible();
  await expect(comparison.getByRole('status')).toHaveCount(0);
  const frames = await page.evaluate(() => {
    document.body.dataset.stopComparisonFrames = 'true';
    return window.comparisonFrames;
  });
  expect(frames.some(text => /Validating key…|Publishing result…|Loading rows…|Loading a row to inspect…/.test(text))).toBe(false);
});

test('keeps the previous summary and values together until refreshed rows are ready', { tag: '@dev' }, async ({ page }, testInfo) => {
  await holdFirstWindow(page);
  await openComparison(page);
  await page.getByRole('button', { name: 'Apply key', exact: true }).click();
  const comparison = page.getByRole('region', { name: 'CSV comparison', exact: true });
  const detail = comparison.getByRole('region', { name: 'Selected comparison row' });
  await expect(detail.getByRole('cell', { name: /candidate changed value: New/ })).toBeVisible();
  const comparisonTab = page.getByRole('tab', { name: /baseline.csv ⇄ candidate.csv/ });
  await page.getByRole('tab', { name: 'candidate.csv', exact: true }).click();
  await editCell(page, 'value', 0, 'After');
  await editCell(page, 'value', 1, 'Also changed');
  await comparisonTab.click();
  const detailBeforeRefresh = await detail.boundingBox();
  await page.evaluate(() => { document.body.dataset.holdFirstWindow = 'true'; });
  await comparison.getByRole('button', { name: 'Refresh comparison', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-first-window-held', 'true');
  await expect(comparison.getByRole('button', { name: 'Changed 1', exact: true })).toBeVisible();
  await expect(detail.getByRole('cell', { name: /candidate changed value: New/ })).toBeVisible();
  expect((await detail.boundingBox())?.y).toBe(detailBeforeRefresh?.y);
  await expect(comparison.getByRole('button', { name: 'Edit key', exact: true })).toBeDisabled();
  await page.screenshot({ path: testInfo.outputPath('waiting-refreshed-window.png') });
  await releaseWindow(page);
  await expect(comparison.getByRole('button', { name: 'Changed 2', exact: true })).toBeVisible();
  await expect(detail.getByRole('cell', { name: /candidate changed value: After/ })).toBeVisible();
  await expect(detail.getByText('Row 1 of 2', { exact: true })).toBeVisible();
});

test('can retry a failed first-window read without publishing an empty Inspector', { tag: '@dev' }, async ({ page }) => {
  await holdFirstWindow(page);
  await openComparison(page);
  await page.evaluate(() => { document.body.dataset.failFirstWindow = 'true'; });
  await page.getByRole('button', { name: 'Apply key', exact: true }).click();
  const comparison = page.getByRole('region', { name: 'CSV comparison', exact: true });
  const alert = comparison.getByRole('alert');
  await expect(alert).toContainText('Unable to load comparison rows. Try again.');
  await expect(comparison.getByRole('heading', { name: 'Choose a Comparison Key', exact: true })).toBeVisible();
  await expect(comparison.getByText('Loading a row to inspect…', { exact: true })).toHaveCount(0);
  await alert.getByRole('button', { name: 'Retry rows', exact: true }).click();
  await expect(comparison.getByRole('region', { name: 'Selected comparison row' }).getByRole('cell', { name: /candidate changed value: New/ })).toBeVisible();
  await expect(alert).toHaveCount(0);
  await comparison.getByRole('button', { name: 'Edit key', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit Comparison Key', exact: true });
  await page.evaluate(() => { document.body.dataset.failFirstWindow = 'true'; });
  await editor.getByRole('button', { name: 'Apply key', exact: true }).click();
  await expect(editor.getByRole('alert')).toContainText('Unable to load comparison rows. Try again.');
  await editor.getByRole('button', { name: 'Retry rows', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(comparison.getByRole('region', { name: 'Selected comparison row' }).getByRole('cell', { name: /candidate changed value: New/ })).toBeVisible();
});
