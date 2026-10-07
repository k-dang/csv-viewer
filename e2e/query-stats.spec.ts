import { expect, test } from '@playwright/test';
import { beforeWorkspaceStarts, csvCells, openColumnFilter, openCsv } from './helpers/csv';

const queryCsv = 'name,team,status\nLinus,kernel,active\nGrace,compiler,active\nAda,compiler,active\nAlan,compiler,paused\n';

test('a delayed stats response cannot replace counts for the latest search', { tag: '@dev' }, async ({ page }, testInfo) => {
  // Hold delivery of one real count result, leaving subsequent queries and the UI usable.
  await beforeWorkspaceStarts(page, `
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
  `);
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

  await openColumnFilter(page, 'team');
  await page.getByRole('searchbox', { name: 'Search values', exact: true }).fill('compiler');
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

test('the Value Filter lists faceted counts, keeps or hides exact values, and searches', async ({ page }, testInfo) => {
  await page.goto('/');
  await openCsv(page, 'query.csv', queryCsv);
  const filter = await openColumnFilter(page, 'team');
  const values = filter.getByRole('list', { name: 'Values', exact: true });
  await expect(values.getByRole('listitem')).toHaveText(['compiler3', 'kernel1']);
  await expect(page.getByRole('searchbox', { name: 'Search values', exact: true })).toBeFocused();
  await page.screenshot({ path: testInfo.outputPath('value-filter.png') });
  await testInfo.attach('value-filter', { path: testInfo.outputPath('value-filter.png'), contentType: 'image/png' });

  await values.getByRole('checkbox', { name: 'kernel' }).uncheck();
  await expect(csvCells(page, 'name')).toHaveText(['Grace', 'Ada', 'Alan']);
  // The column's own pick does not hide its values from the list, so kernel can be checked again.
  await expect(values.getByRole('listitem')).toHaveText(['compiler3', 'kernel1']);
  await expect(filter.getByRole('checkbox', { name: 'Select all' })).toHaveJSProperty('indeterminate', true);

  // A mixed "Select all" checks everything first, as native checkboxes do.
  await filter.getByRole('checkbox', { name: 'Select all' }).check();
  await expect(csvCells(page, 'name')).toHaveText(['Linus', 'Grace', 'Ada', 'Alan']);
  await filter.getByRole('checkbox', { name: 'Select all' }).uncheck();
  await expect(page.getByText('0 visible of 4 rows', { exact: true })).toBeVisible();
  await values.getByRole('checkbox', { name: 'kernel' }).check();
  await expect(csvCells(page, 'name')).toHaveText(['Linus']);

  await filter.getByRole('button', { name: 'Clear filter', exact: true }).click();
  await expect(csvCells(page, 'name')).toHaveText(['Linus', 'Grace', 'Ada', 'Alan']);
  await page.getByRole('searchbox', { name: 'Search values', exact: true }).fill('KER');
  await expect(values.getByRole('listitem')).toHaveText(['kernel1']);
  await expect(csvCells(page, 'name')).toHaveText(['Linus']);
});

test('the cell menu filters a text column to or away from the clicked value', async ({ page }) => {
  await page.goto('/');
  await openCsv(page, 'query.csv', queryCsv);
  await csvCells(page, 'status').filter({ hasText: 'paused' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Exclude this value', exact: true }).click();
  await expect(csvCells(page, 'name')).toHaveText(['Linus', 'Grace', 'Ada']);
  const statusValues = (await openColumnFilter(page, 'status')).getByRole('list', { name: 'Values' });
  await expect(statusValues.getByRole('checkbox', { name: 'paused' })).not.toBeChecked();
  await expect(statusValues.getByRole('checkbox', { name: 'active' })).toBeChecked();
  await page.keyboard.press('Escape');

  await csvCells(page, 'team').filter({ hasText: 'kernel' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Filter to this value', exact: true }).click();
  await expect(csvCells(page, 'name')).toHaveText(['Linus']);
});

test('superseded row requests free their slots, so the latest search still loads', { tag: '@dev' }, async ({ page }) => {
  // Hold the row windows for two searches until released; later queries run normally.
  await beforeWorkspaceStarts(page, `
    const call = started.viewer.call.bind(started.viewer);
    const release = new Promise((resolve) => window.addEventListener('release-rows', resolve, { once: true }));
    started.viewer.call = async (request) => {
      const result = await call(request);
      if (request.operation === 'csv.get-rows' && (request.search === 'Ad' || request.search === 'Ada')) {
        document.body.dataset.heldRows = String(Number(document.body.dataset.heldRows ?? 0) + 1);
        await release;
      }
      return result;
    };
  `);
  await page.goto('/');
  await openCsv(page, 'query.csv', queryCsv);
  const search = page.getByRole('searchbox', { name: 'Global search' });
  await search.fill('Ad');
  await expect(page.locator('body')).toHaveAttribute('data-held-rows', '1');
  await search.fill('Ada');
  await expect(page.locator('body')).toHaveAttribute('data-held-rows', '2');
  await search.fill('Grace');
  await page.evaluate(() => window.dispatchEvent(new Event('release-rows')));
  await expect(csvCells(page, 'name')).toHaveText(['Grace']);
  await expect(page.getByText('1 visible of 4 rows', { exact: true })).toBeVisible();
});

test('Clear query drops a Value Filter search still waiting on its debounce', async ({ page }) => {
  await page.goto('/');
  await openCsv(page, 'query.csv', queryCsv);
  await openColumnFilter(page, 'team');
  const searchValues = page.getByRole('searchbox', { name: 'Search values', exact: true });
  await searchValues.fill('compiler');
  await expect(csvCells(page, 'name')).toHaveText(['Grace', 'Ada', 'Alan']);
  await searchValues.fill('kernel');
  await page.getByRole('button', { name: 'Clear query', exact: true }).click();
  await expect(csvCells(page, 'name')).toHaveText(['Linus', 'Grace', 'Ada', 'Alan']);
  // Outlast the Value Filter's 300ms search debounce: the abandoned draft must not come back.
  await page.waitForTimeout(600);
  await expect(csvCells(page, 'name')).toHaveText(['Linus', 'Grace', 'Ada', 'Alan']);
  await expect(page.getByText('4 visible of 4 rows', { exact: true })).toBeVisible();
});
