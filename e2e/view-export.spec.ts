import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { csvCells, openCsv } from './helpers/csv';

test('exports all matching rows beyond grid windows, commits an editor, and retains Unexported Changes', async ({ page }) => {
  await page.goto('/');
  const rows = Array.from({ length: 800 }, (_, index) => `${index + 1},keep,original`);
  await openCsv(page, 'view.csv', `id,team,note\n${rows.join('\n')}\n801,drop,excluded\n`);
  await csvCells(page, 'note').first().dblclick();
  await page.getByRole('button', { name: 'Export options', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem', { name: 'Export current view · 801 rows', exact: true })).toBeVisible();
  await expect(page.getByRole('img', { name: 'Unexported Changes', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Undo edit', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await page.getByRole('searchbox', { name: 'Global search' }).fill('keep');
  await expect(page.getByText('800 visible of 801 rows', { exact: true })).toBeVisible();
  await csvCells(page, 'note').first().dblclick();
  await page.locator('.ag-cell-inline-editing input').fill('typed, "keep"');
  await page.getByRole('button', { name: 'Export options', exact: true }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: 'Export current view · 800 rows', exact: true }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('view-view.csv');
  const contents = await readFile(await download.path(), 'utf8');
  expect(contents).toBe(`id,team,note\n1,keep,"typed, ""keep"""\n${rows.slice(1).join('\n')}\n`);
  await expect(page.getByRole('status')).toHaveText('Download started · 800 rows');
  await expect(page.getByRole('img', { name: 'Unexported Changes', exact: true })).toBeVisible();
  await page.getByRole('searchbox', { name: 'Global search' }).fill('no-matching-value');
  await expect(page.getByText('0 visible of 801 rows', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Export options', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Export current view · 0 rows', exact: true })).toBeDisabled();
  await expect(page.getByText('No matching rows to export', { exact: true })).toBeVisible();
});

test('cancels preparation while the workspace stays usable and retries the changed query', { tag: '@dev' }, async ({ page }, testInfo) => {
  await page.route((url) => url.pathname === '/src/duckdb-wasm-database.ts', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const anchor = 'return Effect.suspend(() => {';
    expect(source).toContain(anchor);
    await route.fulfill({ response, body: source.replace(anchor, `
      if (document.body.dataset.holdViewExport === 'true') {
        delete document.body.dataset.holdViewExport;
        return Effect.callback(() => Effect.void);
      }
      ${anchor}
    `) });
  });
  await page.goto('/');
  await openCsv(page, 'cancel.csv', 'id,name\n1,Ada\n2,Grace\n');
  const downloads: string[] = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  await page.evaluate(() => { document.body.dataset.holdViewExport = 'true'; });
  await page.getByRole('button', { name: 'Export options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Export current view · 2 rows', exact: true }).click();
  await expect(page.getByText('Preparing export…', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export CSV', exact: true })).toBeDisabled();
  await page.getByRole('searchbox', { name: 'Global search' }).fill('Grace');
  await expect(page.getByText('1 visible of 2 rows', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('preparing-export.png') });
  await page.getByRole('button', { name: 'Cancel export', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Export CSV', exact: true })).toBeEnabled();
  expect(downloads).toEqual([]);
  await page.getByRole('button', { name: 'Export options', exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Export current view · 1 rows', exact: true }).click()]);
  expect(await readFile(await download.path(), 'utf8')).toBe('id,name\n2,Grace\n');
  expect(downloads).toEqual(['cancel-view.csv']);
});

test('keeps a failed active edit open and does not export until it commits', { tag: '@dev' }, async ({ page }) => {
  await page.route((url) => url.pathname === '/src/duckdb-wasm-database.ts', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const anchor = 'return this.calls.effect(() => this.runStatement(sql, values));';
    expect(source).toContain(anchor);
    await route.fulfill({ response, body: source.replace(anchor, `
      if (sql.startsWith('UPDATE ') && document.body.dataset.failCellCommit === 'true') {
        delete document.body.dataset.failCellCommit;
        return this.calls.effect(() => Promise.reject(new Error('Injected cell write failure')));
      }
      ${anchor}
    `) });
  });
  await page.goto('/');
  await openCsv(page, 'commit.csv', 'id,name\n1,Ada\n');
  const downloads: string[] = [];
  page.on('download', (download) => downloads.push(download.suggestedFilename()));
  await csvCells(page, 'name').first().dblclick();
  await page.locator('.ag-cell-inline-editing input').fill('Grace');
  await page.evaluate(() => { document.body.dataset.failCellCommit = 'true'; });
  await page.getByRole('button', { name: 'Export options', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('The data engine could not complete the operation.');
  const editor = page.locator('.ag-cell-inline-editing input');
  await expect(editor).toHaveValue('Grace');
  expect(downloads).toEqual([]);
  await editor.press('Enter');
  await expect(csvCells(page, 'name')).toHaveText(['Grace']);
  await page.getByRole('button', { name: 'Export options', exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Export current view · 1 rows', exact: true }).click()]);
  expect(await readFile(await download.path(), 'utf8')).toBe('id,name\n1,Grace\n');
});

test('preserves text entered while the export menu waits for a cell write', { tag: '@dev' }, async ({ page }) => {
  await page.route((url) => url.pathname === '/src/duckdb-wasm-database.ts', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const anchor = 'return this.calls.effect(() => this.runStatement(sql, values));';
    expect(source).toContain(anchor);
    await route.fulfill({ response, body: source.replace(anchor, `
      if (sql.startsWith('UPDATE ') && document.body.dataset.holdCellCommit === 'true') {
        delete document.body.dataset.holdCellCommit;
        document.body.dataset.cellCommitHeld = 'true';
        return this.calls.effect(() => new Promise((resolve) => {
          document.addEventListener('release-cell-commit', () => resolve(this.runStatement(sql, values)), { once: true });
        }));
      }
      ${anchor}
    `) });
  });
  await page.goto('/');
  await openCsv(page, 'draft.csv', 'id,name\n1,Ada\n');
  await csvCells(page, 'name').first().dblclick();
  const editor = page.locator('.ag-cell-inline-editing input');
  await editor.fill('Grace');
  await page.evaluate(() => { document.body.dataset.holdCellCommit = 'true'; });
  await page.getByRole('button', { name: 'Export options', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-cell-commit-held', 'true');
  await editor.fill('Grace Hopper');
  await page.evaluate(() => { document.dispatchEvent(new Event('release-cell-commit')); });
  await expect(page.getByRole('img', { name: 'Unexported Changes', exact: true })).toBeVisible();
  await expect(editor).toHaveValue('Grace Hopper');
  await expect(page.getByRole('menuitem')).toHaveCount(0);
  await page.getByRole('button', { name: 'Export options', exact: true }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: 'Export current view · 1 rows', exact: true }).click()]);
  expect(await readFile(await download.path(), 'utf8')).toBe('id,name\n1,Grace Hopper\n');
});
