import { writeFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';

async function captureState(page: Page, testInfo: TestInfo, name: string) {
  const screenshot = testInfo.outputPath(`${name}.png`);
  await page.screenshot({ path: screenshot });
  await testInfo.attach(name, { path: screenshot, contentType: 'image/png' });
  const snapshot = testInfo.outputPath(`${name}.aria.txt`);
  await writeFile(snapshot, await page.locator('body').ariaSnapshot());
  await testInfo.attach(`${name} accessibility`, { path: snapshot, contentType: 'text/plain' });
}

async function attachDiagnostics(testInfo: TestInfo, lines: string[]) {
  const diagnosticPath = testInfo.outputPath('diagnostics.txt');
  await writeFile(diagnosticPath, lines.join('\n'));
  await testInfo.attach('diagnostics', { path: diagnosticPath, contentType: 'text/plain' });
}

function captureDiagnostics(page: Page) {
  const lines: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('message=workspace.') || message.text().includes('message=web.')) {
      lines.push(message.text());
    }
  });
  return lines;
}

async function openCsv(page: Page) {
  const [picker] = await Promise.all([
    page.waitForEvent('filechooser'),
    page.getByRole('navigation', { name: 'Workspace' }).getByRole('button', { name: 'Open CSV', exact: true }).click(),
  ]);
  await picker.setFiles({ name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from('name,age\nAda,37\nGrace,41\n') });
  await expect(page.getByRole('gridcell', { name: 'Ada', exact: true })).toBeVisible();
}

test('shows checking and unsupported states when the real engine cannot load', async ({ page }, testInfo) => {
  const diagnostics = captureDiagnostics(page);
  const requested = Promise.withResolvers<void>();
  const failLoad = Promise.withResolvers<void>();
  // Hold the actual engine asset request so checking is observable, then fail at the driver edge.
  await page.route(/\/duckdb-eh(?:-[\w-]+)?\.wasm(?:\?.*)?$/, async (route) => {
    if (route.request().resourceType() === 'script') {
      await route.continue();
      return;
    }
    requested.resolve();
    await failLoad.promise;
    await route.abort('failed');
  });
  try {
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await requested.promise;
    await expect(page.getByRole('heading', { name: 'Checking browser support', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open CSV', exact: true })).toHaveCount(0);
    await captureState(page, testInfo, 'checking');
    failLoad.resolve();
    await expect(page.getByRole('heading', { name: 'This browser cannot start CSV Viewer Web', exact: true })).toBeVisible();
    await expect(page.getByText('You can use CSV Viewer Desktop on this computer instead.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open CSV', exact: true })).toHaveCount(0);
    await expect.poll(() => diagnostics.some((line) => line.includes('message=workspace.acquire-database ') && line.includes('outcome=interrupted'))).toBe(true);
    await captureState(page, testInfo, 'unsupported');
    await attachDiagnostics(testInfo, diagnostics);
  } finally {
    failLoad.resolve();
  }
});

test('a real Worker failure shows the sanitized terminal screen and reload recovers', async ({ page }, testInfo) => {
  const diagnostics = captureDiagnostics(page);
  const workerReady = page.waitForEvent('worker');
  await page.goto('/');
  const worker = await workerReady;
  await openCsv(page);
  await captureState(page, testInfo, 'before-worker-failure');
  // Reject in the live Worker to exercise the unhandledrejection bridge and adapter error listener.
  await worker.evaluate(() => {
    setTimeout(() => { void Promise.reject(new Error('PRIVATE injected Worker failure')); }, 0);
  });
  await expect(page.getByRole('heading', { name: 'The workspace stopped', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Open CSV', exact: true })).toHaveCount(0);
  await expect(page.getByRole('tab')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('PRIVATE injected Worker failure');
  await expect.poll(() => diagnostics.filter((line) => line.includes('message=workspace.engine-stopped ') && line.includes('outcome=failed')).length).toBe(1);
  expect(diagnostics.join('\n')).not.toContain('PRIVATE injected Worker failure');
  await captureState(page, testInfo, 'fatal');

  await page.getByRole('button', { name: 'Reload CSV Viewer', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'CSV Viewer', exact: true })).toBeVisible();
  await expect(page.getByText('No CSV open', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(0);
  await openCsv(page);
  await captureState(page, testInfo, 'recovered');
  await attachDiagnostics(testInfo, diagnostics);
});

test('navigation starts disposal and creates a usable empty workspace', async ({ page }, testInfo) => {
  const diagnostics = captureDiagnostics(page);
  // Observe the existing disposal callback synchronously: unload need not finish async cleanup.
  await page.route('**/src/main.tsx', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const anchor = 'dispose: async () => {';
    expect(source).toContain(anchor);
    await route.fulfill({
      response,
      body: source.replace(anchor, `${anchor}
        localStorage.setItem('e2e-disposal-started', String(Number(localStorage.getItem('e2e-disposal-started') ?? 0) + 1));
      `),
    });
  });
  const workerReady = page.waitForEvent('worker');
  await page.goto('/');
  const oldWorker = await workerReady;
  let oldWorkerClosed = false;
  oldWorker.on('close', () => { oldWorkerClosed = true; });
  await openCsv(page);
  await captureState(page, testInfo, 'before-navigation');
  const oldAcquisition = diagnostics.find((line) => line.includes('message=workspace.acquire-database ') && line.includes('outcome=succeeded'));
  const oldWorkspaceId = oldAcquisition?.match(/workspaceId=([\da-f-]+)/)?.[1];
  expect(oldWorkspaceId).toBeTruthy();

  await page.goto('/?new-workspace');
  await expect(page.getByRole('heading', { name: 'CSV Viewer', exact: true })).toBeVisible();
  await expect(page.getByText('No CSV open', { exact: true })).toBeVisible();
  await expect(page.getByRole('tab')).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('e2e-disposal-started'))).toBe('1');
  await expect.poll(() => oldWorkerClosed).toBe(true);
  const newAcquisition = diagnostics.findLast((line) => line.includes('message=workspace.acquire-database ') && line.includes('outcome=succeeded'));
  const newWorkspaceId = newAcquisition?.match(/workspaceId=([\da-f-]+)/)?.[1];
  expect(newWorkspaceId).toBeTruthy();
  expect(newWorkspaceId).not.toBe(oldWorkspaceId);
  await captureState(page, testInfo, 'after-navigation');
  await openCsv(page);
  await expect(page.getByRole('gridcell', { name: 'Grace', exact: true })).toBeVisible();
  await attachDiagnostics(testInfo, diagnostics);
});
