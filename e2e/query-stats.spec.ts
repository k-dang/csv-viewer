import { expect, test } from '@playwright/test';
import { csvCells, openCsv } from './helpers/csv';

const queryCsv = 'name,team,status\nLinus,kernel,active\nGrace,compiler,active\nAda,compiler,active\nAlan,compiler,paused\n';

test('a delayed stats response cannot replace counts for the latest search', { tag: '@dev' }, async ({ page }, testInfo) => {
  // Hold delivery of one real count result, leaving subsequent queries and the UI usable.
  await page.route((url) => url.pathname === '/src/main.tsx', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const anchor = 'workspace = new RendererWorkspace(started.viewer, {';
    expect(source).toContain(anchor);
    await route.fulfill({ response, body: source.replace(anchor, `
      const call = started.viewer.call.bind(started.viewer);
      let heldStats = false;
      started.viewer.call = async (request) => {
        const result = await call(request);
        if (request.operation === 'csv.get-column-value-counts' && !heldStats) {
          heldStats = true;
          await new Promise((resolve) => {
            window.addEventListener('release-stats', resolve, { once: true });
            document.body.dataset.statsHeld = 'true';
          });
          document.body.dataset.statsReleased = 'true';
        }
        return result;
      };
      ${anchor}
    `) });
  });
  await page.goto('/');
  await openCsv(page, 'query.csv', queryCsv);
  await page.getByRole('button', { name: 'Open stats panel', exact: true }).click();
  const stats = page.getByRole('complementary', { name: 'Stats Panel' });
  await expect(page.locator('body')).toHaveAttribute('data-stats-held', 'true');
  await expect(stats.getByText('Calculating counts', { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath('pending-stats.png') });
  await testInfo.attach('pending-stats', { path: testInfo.outputPath('pending-stats.png'), contentType: 'image/png' });

  await page.getByRole('searchbox', { name: 'Global search' }).fill('Grace');
  await expect(csvCells(page, 'name')).toHaveText(['Grace']);
  await expect(stats.getByText('1 scoped rows', { exact: true })).toBeVisible();
  await page.evaluate(() => window.dispatchEvent(new Event('release-stats')));
  await expect(page.locator('body')).toHaveAttribute('data-stats-released', 'true');
  await expect(stats.getByText('1 scoped rows', { exact: true })).toBeVisible();
  await expect(stats.getByText('4 scoped rows', { exact: true })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('latest-stats.png') });
  await testInfo.attach('latest-stats', { path: testInfo.outputPath('latest-stats.png'), contentType: 'image/png' });
  await testInfo.attach('latest-stats accessibility', { body: await page.locator('body').ariaSnapshot(), contentType: 'text/plain' });
});

test('combines sorting, a column filter, and search; stats follow the query and clear resets it', async ({ page }) => {
  await page.goto('/');
  await openCsv(page, 'query.csv', queryCsv);
  const header = page.getByRole('columnheader', { name: 'name', exact: true });
  await header.click();
  await expect(csvCells(page, 'name')).toHaveText(['Ada', 'Alan', 'Grace', 'Linus']);
  await header.click();
  await expect(csvCells(page, 'name')).toHaveText(['Linus', 'Grace', 'Alan', 'Ada']);
  await expect(page.getByRole('button', { name: 'Append row', exact: true })).toBeDisabled();

  await page.getByRole('columnheader', { name: 'team', exact: true }).focus();
  await page.keyboard.press('Control+Enter');
  await page.getByRole('textbox', { name: 'Filter Value', exact: true }).fill('compiler');
  await page.keyboard.press('Escape');
  await expect(csvCells(page, 'name')).toHaveText(['Grace', 'Alan', 'Ada']);
  await page.getByRole('button', { name: 'Open stats panel', exact: true }).click();
  const stats = page.getByRole('complementary', { name: 'Stats Panel' });
  await stats.getByRole('combobox', { name: 'Stats Column' }).click();
  await page.getByRole('option', { name: 'status', exact: true }).click();
  await expect(stats.getByText('3 scoped rows', { exact: true })).toBeVisible();
  await expect(stats.locator('[data-slot="card-content"]').filter({ hasText: 'active' })).toContainText('66.7%');
  await expect(stats.locator('[data-slot="card-content"]').filter({ hasText: 'paused' })).toContainText('33.3%');
  await page.getByRole('searchbox', { name: 'Global search' }).fill('ACTIVE');
  await expect(csvCells(page, 'name')).toHaveText(['Grace', 'Ada']);
  await expect(stats.getByText('2 scoped rows', { exact: true })).toBeVisible();
  await expect(stats.locator('[data-slot="card-content"]').filter({ hasText: 'active' })).toContainText('100.0%');
  await expect(stats.getByText('paused', { exact: true })).toHaveCount(0);
  await page.getByRole('searchbox', { name: 'Global search' }).fill('no matches');
  await expect(page.getByText('0 visible of 4 rows', { exact: true })).toBeVisible();
  await expect(stats.getByText('No rows in the current count scope.', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Clear query', exact: true }).click();
  await expect(page.getByRole('searchbox', { name: 'Global search' })).toHaveValue('');
  await expect(csvCells(page, 'name')).toHaveText(['Linus', 'Grace', 'Ada', 'Alan']);
  await expect(header).toHaveAttribute('aria-sort', 'none');
  await expect(stats.getByText('4 scoped rows', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Clear query', exact: true })).toBeDisabled();
});
