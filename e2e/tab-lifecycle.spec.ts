import { expect, test } from '@playwright/test';

test('a delayed Reopen response cannot restore a closed CSV Tab', async ({ page }) => {
  // Hold only delivery of the real workspace result. File selection, queries, and close
  // still run through the web runtime; this makes the response-order window deterministic.
  await page.route('**/src/main.tsx', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const anchor = 'workspace = new RendererWorkspace(started.viewer, {';
    expect(source).toContain(anchor);
    await route.fulfill({
      response,
      body: source.replace(anchor, `
        const call = started.viewer.call.bind(started.viewer);
        started.viewer.call = async (request) => {
          const result = await call(request);
          if (request.operation === 'csv.reopen') {
            await new Promise((resolve) => {
              window.addEventListener('release-reopen', resolve, { once: true });
              document.body.dataset.reopenHeld = 'true';
            });
          }
          return result;
        };
        ${anchor}
      `),
    });
  });
  await page.goto('/');
  const openButton = page.locator('header').getByRole('button', { name: 'Open CSV', exact: true });
  const [picker] = await Promise.all([page.waitForEvent('filechooser'), openButton.click()]);
  await picker.setFiles({ name: 'people.csv', mimeType: 'text/csv', buffer: Buffer.from('name\nAda\n') });
  await expect(page.getByRole('gridcell', { name: 'Ada', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Reopen', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-reopen-held', 'true');
  await page.getByRole('button', { name: 'Close people.csv', exact: true }).click();
  await expect(page.getByText('No CSV open', { exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('release-reopen')));
  await expect(openButton).toBeEnabled();
  await expect(page.getByRole('tab', { name: 'people.csv', exact: true })).toHaveCount(0);
});

test('retains CSV query state across Tabs and closes dependent Comparison Tabs after confirmation', async ({ page }) => {
  await page.goto('/');
  for (const name of ['baseline.csv', 'candidate.csv']) {
    const [picker] = await Promise.all([
      page.waitForEvent('filechooser'),
      page.locator('header').getByRole('button', { name: 'Open CSV', exact: true }).click(),
    ]);
    await picker.setFiles({ name, mimeType: 'text/csv', buffer: Buffer.from('name,age\nAda,37\nGrace,41\n') });
    await expect(page.getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
  }
  await page.getByRole('tab', { name: 'baseline.csv', exact: true }).click();
  await page.getByRole('searchbox', { name: 'Global search' }).fill('Ada');
  await expect(page.getByText('1 visible of 2 rows', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Compare…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose a Candidate' }).getByRole('button', { name: /candidate.csv/ }).click();
  await page.getByRole('checkbox', { name: 'name', exact: true }).check();
  await page.getByRole('button', { name: 'Apply key', exact: true }).click();
  await expect(page.getByText('Unchanged 2', { exact: true })).toBeVisible();
  await page.getByRole('tab', { name: 'baseline.csv', exact: true }).click();
  await expect(page.getByRole('searchbox', { name: 'Global search' })).toHaveValue('Ada');
  await expect(page.getByText('1 visible of 2 rows', { exact: true })).toBeVisible();

  const close = page.getByRole('button', { name: 'Close baseline.csv', exact: true });
  const cancelled = page.waitForEvent('dialog').then(async (dialog) => {
    expect(dialog.message()).toContain('dependent Comparison Tabs will also close');
    await dialog.dismiss();
  });
  await close.click();
  await cancelled;
  await expect(page.getByRole('tab')).toHaveCount(3);
  const confirmed = page.waitForEvent('dialog').then((dialog) => dialog.accept());
  await close.click();
  await confirmed;
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('tab', { name: 'candidate.csv', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('gridcell', { name: 'Grace', exact: true })).toBeVisible();
});
