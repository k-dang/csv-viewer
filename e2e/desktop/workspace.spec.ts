import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import { csvCells, editCell } from '../helpers/csv';

const desktopRoot = path.resolve('apps/desktop');
const requireDesktop = createRequire(path.join(desktopRoot, 'package.json'));
let directory: string;
let app: ElectronApplication;
let page: Page;
const contents = 'name,code\nAda,001\nGrace,002\n';

async function launch(): Promise<void> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE' && key !== 'VITE_DEV_SERVER_URL') env[key] = value;
  }
  app = await _electron.launch({
    executablePath: requireDesktop('electron'),
    args: [desktopRoot, `--user-data-dir=${path.join(directory, 'user-data')}`, '--no-sandbox'],
    env,
  });
  await app.context().tracing.start({ screenshots: true, snapshots: true, sources: true });
  page = await app.firstWindow();
  await expect(page.getByRole('heading', { name: 'CSV Viewer', exact: true })).toBeVisible();
}

test.beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), 'csv-viewer-e2e-'));
  await writeFile(path.join(directory, 'people.csv'), contents);
  await launch();
});

// Playwright requires fixture destructuring; Electron owns its own page and context.
// oxlint-disable-next-line no-empty-pattern
test.afterEach(async ({}, testInfo) => {
  if (app && testInfo.status !== testInfo.expectedStatus) {
    const screenshot = testInfo.outputPath('desktop.png');
    await page.screenshot({ path: screenshot });
    await testInfo.attach('desktop', { path: screenshot, contentType: 'image/png' });
    const trace = testInfo.outputPath('trace.zip');
    await app.context().tracing.stop({ path: trace });
    await testInfo.attach('trace', { path: trace, contentType: 'application/zip' });
  }
  await app?.evaluate(({ dialog }) => {
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  });
  await app?.close();
  await rm(directory, { recursive: true, force: true });
});

test('opens and exports through IPC, refuses overwriting the source, and persists recent files', async () => {
  const source = path.join(directory, 'people.csv');
  const destination = path.join(directory, 'exported.csv');
  // Only the OS chooser boundary is substituted. Renderer commands, preload, IPC,
  // native DuckDB, source-conflict handling, and filesystem writes stay real.
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.source] });
    let choice = 0;
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: choice++ === 0 ? paths.source : paths.destination });
    dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
  }, { source, destination });
  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Open CSV', exact: true }).click();
  await expect(csvCells(page, 'name')).toHaveText(['Ada', 'Grace']);
  await editCell(page, 'code', 0, '00042');
  await page.getByRole('button', { name: 'Export CSV', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Export complete');
  expect(await readFile(destination, 'utf8')).toBe('name,code\nAda,00042\nGrace,002\n');
  expect(await readFile(source, 'utf8')).toBe(contents);
  await expect(page.getByRole('img', { name: 'Unexported Changes', exact: true })).toHaveCount(0);
  await app.context().tracing.stop();
  await app.close();
  await launch();
  await page.getByRole('button', { name: /people.csv/ }).click();
  await expect(csvCells(page, 'code')).toHaveText(['001', '002']);
  const recent = await readFile(path.join(directory, 'user-data', 'recent-files.json'), 'utf8');
  expect(JSON.parse(recent)).toEqual(expect.arrayContaining([expect.objectContaining({ path: source })]));
});

test('exports a filtered view and keeps the desktop export menu mapped to the complete CSV', async () => {
  const source = path.join(directory, 'people.csv');
  const viewDestination = path.join(directory, 'people-view.csv');
  const fullDestination = path.join(directory, 'people-edited.csv');
  await app.evaluate(({ dialog }, paths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [paths.source] });
    let choice = 0;
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: choice++ === 0 ? paths.viewDestination : paths.fullDestination });
  }, { source, viewDestination, fullDestination });
  await page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Open CSV', exact: true }).click();
  await expect(csvCells(page, 'name')).toHaveText(['Ada', 'Grace']);
  await editCell(page, 'code', 0, '00042');
  await page.getByRole('searchbox', { name: 'Global search' }).fill('Ada');
  await expect(page.getByText('1 visible of 2 rows', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Export options', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Export current view · 1 rows', exact: true }).click();
  await expect(page.getByRole('status')).toHaveText('Export complete · 1 rows');
  expect(await readFile(viewDestination, 'utf8')).toBe('name,code\nAda,00042\n');
  await expect(page.getByRole('img', { name: 'Unexported Changes', exact: true })).toBeVisible();
  await app.evaluate(({ Menu, BrowserWindow }) => {
    const item = Menu.getApplicationMenu()?.items.find((entry) => entry.label === 'File')?.submenu?.items.find((entry) => entry.label === 'Export CSV...');
    if (!item) throw new Error('Export CSV menu item missing');
    item.click(item, BrowserWindow.getAllWindows()[0], {});
  });
  await expect(page.getByRole('status')).toHaveText('Export complete');
  expect(await readFile(fullDestination, 'utf8')).toBe('name,code\nAda,00042\nGrace,002\n');
  expect(await readFile(source, 'utf8')).toBe(contents);
  await expect(page.getByRole('img', { name: 'Unexported Changes', exact: true })).toHaveCount(0);
});

test('dropping the same desktop source focuses its edited tab and reopen respects discard confirmation', async () => {
  const source = path.join(directory, 'people.csv');
  const session = await page.context().newCDPSession(page);
  async function drop(): Promise<void> {
    const data = { items: [], files: [source], dragOperationsMask: 1 };
    for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
      await session.send('Input.dispatchDragEvent', { type, x: 450, y: 250, data });
    }
  }
  try {
    await drop();
    await expect(csvCells(page, 'name')).toHaveText(['Ada', 'Grace']);
    await editCell(page, 'name', 0, 'Ada edited');
    await drop();
    await expect(page.getByRole('tab')).toHaveCount(1);
    await expect(csvCells(page, 'name')).toHaveText(['Ada edited', 'Grace']);
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1, checkboxChecked: false });
    });
    await page.getByRole('button', { name: 'Reopen', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Reopen', exact: true })).toBeEnabled();
    await expect(csvCells(page, 'name')).toHaveText(['Ada edited', 'Grace']);
    await app.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 0, checkboxChecked: false });
    });
    await page.getByRole('button', { name: 'Reopen', exact: true }).click();
    await expect(csvCells(page, 'name')).toHaveText(['Ada', 'Grace']);
    await expect(page.getByRole('img', { name: 'Unexported Changes', exact: true })).toHaveCount(0);
    expect(await readFile(source, 'utf8')).toBe(contents);
  } finally {
    await session.detach();
  }
});
