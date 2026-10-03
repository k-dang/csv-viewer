import { expect, test } from '@playwright/test';
import { csvCells, editCell, exportCsv, openCsv } from './helpers/csv';

test('reopens with explicit header and delimiter options and exports that dialect', async ({ page }) => {
  await page.goto('/');
  await openCsv(page, 'pipe.txt', 'name|code\nAda|001\nGrace|002\n');
  await page.getByRole('button', { name: 'Parse options', exact: true }).click();
  await page.getByRole('textbox', { name: 'Delimiter', exact: true }).fill('|');
  await page.getByRole('combobox', { name: 'Headers', exact: true }).click();
  await page.getByRole('option', { name: 'None', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Reopen', exact: true }).click();
  await expect(page.locator('.ag-header-cell-text')).toHaveText(['column0', 'column1']);
  await expect(csvCells(page, 'column0')).toHaveText(['name', 'Ada', 'Grace']);
  await editCell(page, 'column1', 1, '00042');
  expect(await exportCsv(page, 'pipe.txt')).toBe('name|code\nAda|00042\nGrace|002\n');
  await page.getByRole('button', { name: 'Parse options', exact: true }).click();
  await page.getByRole('combobox', { name: 'Headers', exact: true }).click();
  await page.getByRole('option', { name: 'First row', exact: true }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Reopen', exact: true }).click();
  await expect(page.locator('.ag-header-cell-text')).toHaveText(['name', 'code']);
  await expect(csvCells(page, 'code')).toHaveText(['001', '002']);
});

test('round trips quotes, embedded commas, multiline fields, empty values, and leading zeros', async ({ page }) => {
  await page.goto('/');
  const contents = 'code,note,blank\n001,"commas, and ""quotes""",\n002,"line one\nline two",\n';
  await openCsv(page, 'quoted.csv', contents);
  await expect(csvCells(page, 'note')).toHaveText(['commas, and "quotes"', 'line one\nline two']);
  await editCell(page, 'code', 0, '00042');
  const exported = await exportCsv(page, 'quoted.csv');
  expect(exported).toBe(contents.replace('001,', '00042,'));
  await openCsv(page, 'round-trip.csv', exported);
  await expect(csvCells(page, 'code')).toHaveText(['00042', '002']);
  await expect(csvCells(page, 'note')).toHaveText(['commas, and "quotes"', 'line one\nline two']);
  await expect(csvCells(page, 'blank')).toHaveText(['[null]', '[null]']);
});
