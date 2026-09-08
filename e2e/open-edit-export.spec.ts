import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';

test('opens a CSV, edits a cell, and exports the changed contents', async ({ page }) => {
  await page.goto('/');
  const [picker] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.locator('header').getByRole('button', { name: 'Open CSV', exact: true }).click(),
  ]);
  await picker.setFiles({
    name: 'people.csv',
    mimeType: 'text/csv',
    buffer: Buffer.from('name,age\nAda,37\nGrace,41\n'),
  });

  await expect(page.getByRole('tab', { name: 'people.csv', exact: true })).toBeVisible();
  await page.getByRole('gridcell', { name: 'Ada', exact: true }).dblclick();
  await page.locator('.ag-cell-inline-editing input').fill('Katherine');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('gridcell', { name: 'Katherine', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Unexported Changes', exact: true })).toBeVisible();

  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export CSV', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('people.csv');
  expect(await readFile(await download.path(), 'utf8')).toBe('name,age\nKatherine,37\nGrace,41\n');
  await expect(page.getByRole('status')).toHaveText('Download started');
  await expect(page.getByRole('img', { name: 'Unexported Changes', exact: true })).toHaveCount(0);
});
