import { expect, test, type Page } from '@playwright/test';
import { csvCells, openCsv } from './helpers/csv';

async function expectFocusedColumn(page: Page, focusedColumn?: string): Promise<void> {
  for (const column of ['id', 'name', 'email']) {
    const header = page.locator('.csv-view:visible').getByRole('columnheader', { name: column, exact: true });
    const cell = csvCells(page, column).nth(1);
    for (const element of [header, cell]) {
      if (column === focusedColumn) {
        await expect(element).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      } else {
        await expect(element).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
      }
    }
  }
}

test('column focus stays within its CSV tab when selecting cells and switching tabs', async ({ page }) => {
  await page.goto('/');
  const contents = 'id,name,email\n1,Ada,ada@example.test\n2,Grace,grace@example.test\n';
  await openCsv(page, 'first.csv', contents);
  await csvCells(page, 'name').first().click();
  await expectFocusedColumn(page, 'name');

  await openCsv(page, 'second.csv', contents);
  await expectFocusedColumn(page);
  await csvCells(page, 'email').first().click();
  await expectFocusedColumn(page, 'email');

  await page.getByRole('tab', { name: 'first.csv', exact: true }).click();
  await expectFocusedColumn(page, 'name');
  await csvCells(page, 'id').first().click();
  await expectFocusedColumn(page, 'id');

  await page.getByRole('tab', { name: 'second.csv', exact: true }).click();
  await expectFocusedColumn(page, 'email');
  await csvCells(page, 'name').first().click();
  await expectFocusedColumn(page, 'name');
});
