import { readFile } from 'node:fs/promises';
import { expect, type Page } from '@playwright/test';

/** Opens through the real file picker and waits for the grid's first data window. */
export async function openCsv(page: Page, name: string, contents: string): Promise<void> {
  const [picker] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Open CSV', exact: true }).click(),
  ]);
  await picker.setFiles({ name, mimeType: 'text/csv', buffer: Buffer.from(contents) });
  await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.csv-view:visible .ag-center-cols-container [role="row"]').first()).toBeVisible();
  await expect(page.locator('.csv-view:visible').getByText('Ready', { exact: true })).toBeVisible();
}

export function csvCells(page: Page, column: string) {
  return page.locator('.csv-view:visible .ag-center-cols-container').getByRole('gridcell').and(page.locator(`[col-id="${column}"]`));
}

export async function editCell(page: Page, column: string, row: number, value: string): Promise<void> {
  await csvCells(page, column).nth(row).dblclick();
  const editor = page.locator('.ag-cell-inline-editing input');
  await expect(editor).toBeFocused();
  await editor.fill(value);
  await editor.press('Enter');
  await expect(csvCells(page, column).nth(row)).toHaveText(value);
  await expect(page.locator('.csv-view:visible').getByRole('button', { name: 'Undo edit', exact: true })).toBeEnabled();
}

/** Reads the browser download rather than inferring success from a toast. */
export async function exportCsv(page: Page, filename: string): Promise<string> {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export CSV', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe(filename);
  const contents = await readFile(await download.path(), 'utf8');
  await expect(page.getByRole('status')).toHaveText('Download started');
  await expect(page.getByRole('img', { name: 'Unexported Changes', exact: true })).toHaveCount(0);
  return contents;
}

export async function columnMenu(page: Page, column: string, action: string): Promise<void> {
  await page.getByRole('columnheader', { name: column, exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}
