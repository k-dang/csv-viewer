import { expect, test, type Page } from '@playwright/test';
import { mkdtemp, mkdir, rm, truncate, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

let directory: string;
test.beforeEach(async () => { directory = await mkdtemp(path.join(tmpdir(), 'csv-viewer-drop-')); });
test.afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

async function file(name: string, contents = 'name,age\nAda,37\nGrace,41\n'): Promise<string> {
  const filePath = path.join(directory, name);
  await writeFile(filePath, contents);
  return filePath;
}

async function drop(page: Page, files: string[], hover = false) {
  const session = await page.context().newCDPSession(page);
  try {
    const data = { items: [], files, dragOperationsMask: 1 };
    await session.send('Input.dispatchDragEvent', { type: 'dragEnter', x: 400, y: 250, data });
    await session.send('Input.dispatchDragEvent', { type: 'dragOver', x: 400, y: 250, data });
    if (!hover) await session.send('Input.dispatchDragEvent', { type: 'drop', x: 400, y: 250, data });
  } finally {
    await session.detach();
  }
}

test('opens a mixed drop, summarizes failures, and preserves edits when more files are dropped', async ({ page }) => {
  const first = await file('people.csv');
  const unsupported = await file('notes.pdf');
  const folder = path.join(directory, 'folder.csv');
  await mkdir(folder);
  const oversized = await file('oversized.csv', '');
  await truncate(oversized, 100_000_001);
  const text = await file('more.txt');
  const tsv = await file('last.TSV', 'name\tage\nKatherine\t42\n');
  await page.goto('/');
  await expect(page.getByText('Drop CSV, TSV, or TXT files anywhere to open them.')).toBeVisible();
  await drop(page, [first], true);
  await expect(page.getByText('Drop files to open', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByText('Drop files to open', { exact: true })).toHaveCount(0);
  await drop(page, [first, unsupported, folder, oversized, text, tsv]);
  await expect(page.getByRole('tab', { name: 'last.TSV', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByText('Drop files to open', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(3);
  await expect(page.getByRole('gridcell', { name: 'Katherine', exact: true })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: '42', exact: true })).toBeVisible();
  const alert = page.getByRole('alert');
  for (const name of ['notes.pdf', 'folder.csv', 'oversized.csv']) await expect(alert).toContainText(name);
  await expect(alert).toContainText('100 MB');

  await page.getByRole('tab', { name: 'people.csv', exact: true }).click();
  await page.getByRole('gridcell', { name: 'Ada', exact: true }).dblclick();
  await page.locator('.ag-cell-inline-editing input').fill('Ada Edited');
  await page.keyboard.press('Enter');
  await expect(page.getByText('Unexported Changes', { exact: true })).toBeVisible();
  await drop(page, [first]);
  await expect(page.getByRole('tab')).toHaveCount(4);
  await expect(page.getByRole('gridcell', { name: 'Ada', exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'people.csv Unexported Changes', exact: true }).click();
  await expect(page.getByRole('gridcell', { name: 'Ada Edited', exact: true })).toBeVisible();
});

test('blocks drops inside a modal and preserves the candidate picker', async ({ page }) => {
  const first = await file('first.csv');
  const second = await file('second.csv');
  const third = await file('third.csv');
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'CSV Viewer', exact: true })).toBeVisible();
  await drop(page, [first, second]);
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.getByRole('button', { name: 'Compare…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Choose a Candidate' });
  await expect(dialog).toBeVisible();
  await drop(page, [third], true);
  await expect(page.getByText('Drop files to open', { exact: true })).toHaveCount(0);
  await drop(page, [third]);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page).toHaveURL(/127\.0\.0\.1/);
  await drop(page, [third]);
  await expect(page.getByRole('tab', { name: 'third.csv', exact: true })).toBeVisible();
});

test('declines a second drop while the first source is being acquired', async ({ page }) => {
  await page.route('**/src/web-composition.ts', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const anchor = 'acquireDroppedSource: async (file) => host.registerSource(file)';
    expect(source).toContain(anchor);
    await route.fulfill({ response, body: source.replace(anchor, `acquireDroppedSource: async (file) => {
      await new Promise(resolve => window.addEventListener('release-drop', resolve, { once: true }));
      return host.registerSource(file);
    }`) });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'CSV Viewer', exact: true })).toBeVisible();
  await drop(page, [await file('first.csv')]);
  await expect(page.locator('header').getByRole('button', { name: 'Opening...', exact: true })).toBeDisabled();
  await drop(page, [await file('second.csv')]);
  await expect(page.getByText('Files are still opening. Try again when finished.', { exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('release-drop')));
  await expect(page.getByRole('tab', { name: 'first.csv', exact: true })).toBeVisible();
  await expect(page.locator('header').getByRole('button', { name: 'Open CSV', exact: true })).toBeEnabled();
  await expect(page.getByRole('tab')).toHaveCount(1);
});
