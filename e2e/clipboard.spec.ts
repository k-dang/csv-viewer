import { expect, test } from '@playwright/test';
import { columnMenu, csvCells, openCsv } from './helpers/csv';

test('copies query-scoped column values in sort order and distinguishes cell and column shortcuts', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await openCsv(page, 'copy.csv', 'name,team\nLinus,kernel\nGrace,compiler\nAda,compiler\n');
  await page.getByRole('columnheader', { name: 'name', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Global search' }).fill('compiler');
  await expect(csvCells(page, 'name')).toHaveText(['Ada', 'Grace']);
  await columnMenu(page, 'name', 'Copy column');
  await expect(page.getByText('Copied 2 values', { exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.readText()).replaceAll('\r\n', '\n'))).toBe('Ada\nGrace');
  await page.getByRole('gridcell', { name: 'Grace', exact: true }).click();
  // The closing Column Menu must not pull focus back to its header once its animation ends.
  await expect(page.getByRole('menu')).toHaveCount(0);
  await expect(page.getByRole('gridcell', { name: 'Grace', exact: true })).toBeFocused();
  await page.keyboard.press('ControlOrMeta+c');
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('Grace');
  await page.keyboard.press('ControlOrMeta+Shift+a');
  await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.readText()).replaceAll('\r\n', '\n'))).toBe('Ada\nGrace');
  await expect(page.getByRole('img', { name: 'Unexported Changes', exact: true })).toHaveCount(0);
});
