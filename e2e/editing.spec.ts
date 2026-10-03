import { expect, test } from '@playwright/test';
import { columnMenu, csvCells, editCell, exportCsv, openCsv } from './helpers/csv';

test('inserts, appends, and deletes rows with undo/redo and exports source order', async ({ page }) => {
  await page.goto('/');
  await openCsv(page, 'rows.csv', 'name,code\nAda,001\nGrace,002\nLinus,003\n');
  await expect(page.getByRole('button', { name: 'Undo edit', exact: true })).toBeDisabled();
  await page.getByRole('gridcell', { name: 'Grace', exact: true }).click();
  await page.getByRole('button', { name: 'Insert row above', exact: true }).click();
  await expect(csvCells(page, 'name')).toHaveText(['Ada', '[empty]', 'Grace', 'Linus']);
  await editCell(page, 'name', 1, 'Katherine');
  await editCell(page, 'code', 1, '00042');
  await page.getByRole('button', { name: 'Append row', exact: true }).click();
  await expect(csvCells(page, 'name')).toHaveText(['Ada', 'Katherine', 'Grace', 'Linus', '[empty]']);
  await editCell(page, 'name', 4, 'Alan');
  await page.getByRole('gridcell', { name: 'Ada', exact: true }).click();
  await page.getByRole('gridcell', { name: 'Linus', exact: true }).click({ modifiers: ['ControlOrMeta'] });
  await page.getByRole('button', { name: 'Delete selected rows', exact: true }).click();
  await expect(csvCells(page, 'name')).toHaveText(['Katherine', 'Grace', 'Alan']);
  await page.getByRole('button', { name: 'Undo edit', exact: true }).click();
  await expect(csvCells(page, 'name')).toHaveText(['Ada', 'Katherine', 'Grace', 'Linus', 'Alan']);
  await page.getByRole('button', { name: 'Redo edit', exact: true }).click();
  await expect(csvCells(page, 'name')).toHaveText(['Katherine', 'Grace', 'Alan']);
  expect(await exportCsv(page, 'rows.csv')).toBe('name,code\nKatherine,00042\nGrace,002\nAlan,\n');
  // Export becomes the new clean revision; history must track that boundary too.
  await page.getByRole('button', { name: 'Undo edit', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Unexported Changes', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Redo edit', exact: true }).click();
  await expect(page.getByRole('img', { name: 'Unexported Changes', exact: true })).toHaveCount(0);
});

test('inserts relative to a searched source row while append remains disabled', async ({ page }) => {
  await page.goto('/');
  await openCsv(page, 'filtered.csv', 'name\nAda\nGrace\nLinus\n');
  await page.getByRole('searchbox', { name: 'Global search' }).fill('Grace');
  await expect(csvCells(page, 'name')).toHaveText(['Grace']);
  await expect(page.getByRole('button', { name: 'Append row', exact: true })).toBeDisabled();
  await page.getByRole('gridcell', { name: 'Grace', exact: true }).click();
  await page.getByRole('button', { name: 'Insert row below', exact: true }).click();
  await expect(page.getByText('1 visible of 4 rows', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Undo edit', exact: true }).click();
  await expect(page.getByText('1 visible of 3 rows', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Redo edit', exact: true }).click();
  await expect(page.getByText('1 visible of 4 rows', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear query', exact: true }).click();
  await expect(csvCells(page, 'name')).toHaveText(['Ada', 'Grace', '[empty]', 'Linus']);
  await page.getByRole('button', { name: 'Undo edit', exact: true }).click();
  await expect(csvCells(page, 'name')).toHaveText(['Ada', 'Grace', 'Linus']);
  await expect(page.getByRole('img', { name: 'Unexported Changes', exact: true })).toHaveCount(0);
});

test('renames and restructures columns, rejects invalid names, and restores deleted data', async ({ page }) => {
  await page.goto('/');
  await openCsv(page, 'columns.csv', 'name,email,code\nAda,ada@example.com,001\nGrace,grace@example.com,002\n');
  await columnMenu(page, 'email', 'Rename column');
  const name = page.getByRole('textbox', { name: 'Column name', exact: true });
  await expect(name).toBeFocused();
  await name.fill('name');
  await name.press('Enter');
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  await expect(page.getByRole('alert')).toHaveText('CSV column name already exists.');
  await name.fill(' ');
  await name.press('Enter');
  await expect(page.getByRole('alert')).toHaveText('CSV column name cannot be blank.');
  await name.fill('__csvViewerRowId');
  await name.press('Enter');
  await expect(page.getByRole('alert')).toHaveText('CSV column name is reserved.');
  await name.fill('contact');
  await name.press('Enter');
  await expect(page.locator('.ag-header-cell-text')).toHaveText(['name', 'contact', 'code']);
  await columnMenu(page, 'contact', 'Insert column left');
  await expect(page.locator('.ag-header-cell-text')).toHaveText(['name', 'New column', 'contact', 'code']);
  await page.getByRole('button', { name: 'Undo edit', exact: true }).click();
  await expect(page.locator('.ag-header-cell-text')).toHaveText(['name', 'contact', 'code']);
  await columnMenu(page, 'contact', 'Insert column right');
  await expect(page.locator('.ag-header-cell-text')).toHaveText(['name', 'contact', 'New column', 'code']);
  await page.getByRole('button', { name: 'Undo edit', exact: true }).click();
  await expect(page.locator('.ag-header-cell-text')).toHaveText(['name', 'contact', 'code']);
  await columnMenu(page, 'contact', 'Delete column');
  await expect(page.getByRole('gridcell', { name: 'grace@example.com', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Undo edit', exact: true }).click();
  await expect(page.locator('.ag-header-cell-text')).toHaveText(['name', 'contact', 'code']);
  await expect(csvCells(page, 'contact')).toHaveText(['ada@example.com', 'grace@example.com']);
  // F2 must enter the same rename flow without a pointer menu.
  await csvCells(page, 'name').first().click();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('F2');
  await expect(name).toBeFocused();
  await name.fill('full_name');
  await name.press('Enter');
  await expect(page.locator('.ag-header-cell-text')).toHaveText(['full_name', 'contact', 'code']);
  expect(await exportCsv(page, 'columns.csv')).toBe('full_name,contact,code\nAda,ada@example.com,001\nGrace,grace@example.com,002\n');
});

test('prevents deleting the last column', async ({ page }) => {
  await page.goto('/');
  await openCsv(page, 'single.csv', 'name\nAda\n');
  await page.getByRole('columnheader', { name: 'name', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Delete column', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  expect(await exportCsv(page, 'single.csv')).toBe('name\nAda\n');
});
