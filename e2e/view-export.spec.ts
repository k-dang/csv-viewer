import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { csvCells, openCsv } from './helpers/csv';

test('reports both export preparation and worker cleanup failures', { tag: '@dev' }, async ({ page }) => {
  await page.route((url) => url.pathname === '/src/duckdb-wasm-database.ts', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const read = 'return Effect.suspend(() => {';
    const close = 'return this.calls.effect(() => this.disconnect());';
    expect(source).toContain(read);
    expect(source).toContain(close);
    await route.fulfill({ response, body: source.replace(read, `
      if (document.body.dataset.failExportRead === 'true') {
        delete document.body.dataset.failExportRead;
        return this.calls.effect(() => Promise.reject(new Error('Injected export read failure')));
      }
      ${read}
    `).replace(close, `
      if (document.body.dataset.failExportClose === 'true') {
        delete document.body.dataset.failExportClose;
        return this.calls.effect(() => Promise.reject(new Error('Injected export close failure')));
      }
      ${close}
    `) });
  });
  await page.goto('/');
  await openCsv(page, 'failures.csv', 'id,name\n1,Ada\n');
  await page.evaluate(() => {
    document.body.dataset.failExportRead = 'true';
    document.body.dataset.failExportClose = 'true';
  });
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  // The transport exposes a combined failure through its generic, sanitized message.
  await expect(page.getByRole('alert')).toHaveText('The CSV workspace could not complete the request.');
  await expect(page.getByRole('button', { name: 'Export CSV', exact: true })).toBeEnabled();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Export CSV', exact: true }).click(),
  ]);
  expect(await readFile(await download.path(), 'utf8')).toBe('id,name\n1,Ada\n');
});

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
