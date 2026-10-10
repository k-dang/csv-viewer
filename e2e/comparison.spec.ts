import { expect, test, type Page } from '@playwright/test';
import { beforeWorkspaceStarts, editCell, openCsv } from './helpers/csv';

async function compare(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'baseline.csv', exact: true }).click();
  await page.getByRole('button', { name: 'Compare…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose a Candidate' }).getByRole('button', { name: /candidate.csv/ }).click();
  await expect(page.getByRole('region', { name: 'CSV comparison', exact: true })).toBeVisible();
}

test('keeps the settled comparison visible while populated and empty filters load', { tag: '@dev' }, async ({ page }, testInfo) => {
  // Hold delivery of a real row window so the intermediate UI is observable on every machine.
  await beforeWorkspaceStarts(page, `
    const call = started.viewer.call.bind(started.viewer);
    started.viewer.call = async (request) => {
      const outcome = await call(request);
      if (request.operation === 'comparison.get-window' && document.body.dataset.holdComparisonRows === 'true') {
        document.body.dataset.comparisonRowsHeld = 'true';
        await new Promise(resolve => window.addEventListener('release-comparison-rows', resolve, { once: true }));
      }
      return outcome;
    };
  `);
  await page.goto('/');
  await openCsv(page, 'baseline.csv', 'id,value\n1,Old\n2,Same\n');
  await openCsv(page, 'candidate.csv', 'id,value\n1,New\n2,Same\n');
  await compare(page);
  await page.getByRole('checkbox', { name: 'id', exact: true }).check();
  await page.getByRole('button', { name: 'Apply key', exact: true }).click();
  const comparison = page.getByRole('region', { name: 'CSV comparison', exact: true });
  const detail = comparison.getByRole('region', { name: 'Selected comparison row' });
  await expect(detail.getByRole('heading', { name: 'id 1', exact: true })).toBeVisible();
  await page.evaluate(() => { document.body.dataset.holdComparisonRows = 'true'; });
  await comparison.getByRole('button', { name: 'Unchanged 1', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-comparison-rows-held', 'true');
  await page.screenshot({ path: testInfo.outputPath('pending-comparison-filter.png') });
  await expect(comparison.getByRole('grid', { name: 'Comparison rows' }).getByRole('gridcell', { name: /id 1/ })).toBeVisible();
  await expect(comparison.getByText('1 row · select to inspect', { exact: true })).toBeVisible();
  await expect(detail.getByText('Row 1 of 1', { exact: true })).toBeVisible();
  await expect(comparison.getByText('Loading rows…', { exact: true })).toHaveCount(0);
  await expect(detail.getByRole('cell', { name: /candidate changed value: New/ })).toBeVisible();
  await expect(detail.getByText('Loading a row to inspect…', { exact: true })).toHaveCount(0);
  await expect(comparison.getByRole('button', { name: 'Previous row', exact: true })).toBeDisabled();
  await expect(comparison.getByRole('button', { name: 'Next row', exact: true })).toBeDisabled();
  await page.evaluate(() => {
    delete document.body.dataset.holdComparisonRows;
    window.dispatchEvent(new Event('release-comparison-rows'));
  });
  await expect(detail.getByRole('heading', { name: 'id 2', exact: true })).toBeVisible();
  await expect(detail.getByRole('cell', { name: /^Same/ })).toHaveCount(2);
  for (const view of ['Inspector', 'Grid']) {
    await comparison.getByRole('button', { name: view, exact: true }).click();
    await comparison.getByRole('button', { name: 'Baseline-only 0', exact: true }).click();
    await expect(comparison.getByRole('heading', { name: 'No matching rows', exact: true })).toBeVisible();
    for (const filter of ['Candidate-only 0', 'Changed 1']) {
      await page.evaluate(() => {
        delete document.body.dataset.comparisonRowsHeld;
        document.body.dataset.holdComparisonRows = 'true';
      });
      await comparison.getByRole('button', { name: filter, exact: true }).click();
      await expect(page.locator('body')).toHaveAttribute('data-comparison-rows-held', 'true');
      await page.screenshot({ path: testInfo.outputPath(`pending-${view}-${filter.split(' ')[0]}.png`) });
      await expect(comparison.getByRole('heading', { name: 'No matching rows', exact: true })).toBeVisible();
      await expect(detail.getByText('Loading a row to inspect…', { exact: true })).toBeHidden();
      await page.evaluate(() => {
        delete document.body.dataset.holdComparisonRows;
        window.dispatchEvent(new Event('release-comparison-rows'));
      });
      await expect(comparison.getByText(`${filter === 'Changed 1' ? 1 : 0} of 2 rows`, { exact: true })).toBeVisible();
    }
  }
  await page.evaluate(() => {
    delete document.body.dataset.comparisonRowsHeld;
    document.body.dataset.holdComparisonRows = 'true';
  });
  await comparison.getByRole('button', { name: 'Unchanged 1', exact: true }).click();
  await expect(page.locator('body')).toHaveAttribute('data-comparison-rows-held', 'true');
  await expect(comparison.getByRole('grid', { name: 'Aligned comparison results' }).getByRole('gridcell', { name: /id 1/ })).toBeVisible();
  await comparison.getByRole('grid', { name: 'Aligned comparison results' }).getByRole('gridcell', { name: /id 1/ }).click();
  await expect(comparison.getByRole('button', { name: 'Grid', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(comparison.getByText('Loading rows…', { exact: true })).toHaveCount(0);
  await page.evaluate(() => {
    delete document.body.dataset.holdComparisonRows;
    window.dispatchEvent(new Event('release-comparison-rows'));
  });
  await expect(comparison.getByRole('gridcell', { name: /id 2/ })).toBeVisible();
  await comparison.getByRole('button', { name: 'Inspector', exact: true }).click();
  await expect(detail.getByRole('heading', { name: 'id 2', exact: true })).toBeVisible();
});

test('exposes row failures outside busy content and retries without allowing stale selection', { tag: '@dev' }, async ({ page }, testInfo) => {
  await beforeWorkspaceStarts(page, `
    const call = started.viewer.call.bind(started.viewer);
    started.viewer.call = async (request) => {
      const outcome = await call(request);
      if (request.operation === 'comparison.get-window' && document.body.dataset.failComparisonRows === 'true') {
        delete document.body.dataset.failComparisonRows;
        throw new Error('Injected row delivery failure');
      }
      return outcome;
    };
  `);
  await page.goto('/');
  await openCsv(page, 'baseline.csv', 'id,value\n1,Old\n2,Before\n3,Same\n');
  await openCsv(page, 'candidate.csv', 'id,value\n1,New\n2,After\n3,Same\n');
  await compare(page);
  await page.getByRole('checkbox', { name: 'id', exact: true }).check();
  await page.getByRole('button', { name: 'Apply key', exact: true }).click();
  const comparison = page.getByRole('region', { name: 'CSV comparison', exact: true });
  const detail = comparison.getByRole('region', { name: 'Selected comparison row' });
  await expect(detail.getByRole('heading', { name: 'id 1', exact: true })).toBeVisible();
  await expect(comparison.getByRole('button', { name: 'Next row', exact: true })).toBeEnabled();
  await page.evaluate(() => { document.body.dataset.failComparisonRows = 'true'; });
  await comparison.getByRole('button', { name: 'Unchanged 1', exact: true }).click();
  const alert = comparison.getByRole('alert');
  await expect(alert).toContainText('Unable to load comparison rows. Try again.');
  await page.screenshot({ path: testInfo.outputPath('comparison-row-failure.png') });
  expect(await alert.evaluate(element => element.closest('[aria-busy="true"]') !== null)).toBe(false);
  await expect(detail).toHaveAttribute('aria-busy', 'true');
  await expect(comparison.getByRole('button', { name: 'Next row', exact: true })).toBeDisabled();
  await comparison.getByRole('grid', { name: 'Comparison rows' }).getByRole('gridcell', { name: /id 2/ }).click();
  await expect(detail.getByRole('heading', { name: 'id 1', exact: true })).toBeVisible();
  await alert.getByRole('button', { name: 'Retry rows', exact: true }).click();
  await expect(detail.getByRole('heading', { name: 'id 3', exact: true })).toBeVisible();
  await expect(detail).toHaveAttribute('aria-busy', 'false');
  await expect(alert).toHaveCount(0);
});

test('centers Inspector copy buttons beside single-line and multiline values', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await openCsv(page, 'baseline.csv', 'id,total_spend,note\n1,1.0,"First line\nSecond line\nThird line"\n');
  await openCsv(page, 'candidate.csv', 'id,total_spend,note\n1,1.5,"Updated first line\nUpdated second line"\n');
  await compare(page);
  await page.getByRole('checkbox', { name: 'id', exact: true }).check();
  await page.getByRole('button', { name: 'Apply key', exact: true }).click();
  const detail = page.getByRole('region', { name: 'Selected comparison row' });
  const buttons = detail.getByRole('button', { name: /^Copy (baseline|candidate) value for / });
  await expect(buttons).toHaveCount(4);
  for (const button of await buttons.all()) {
    const offset = await button.evaluate(element => {
      const value = element.previousElementSibling!.getBoundingClientRect();
      const icon = element.querySelector('svg')!.getBoundingClientRect();
      return Math.abs(icon.y + icon.height / 2 - value.y - value.height / 2);
    });
    expect(offset, await button.getAttribute('aria-label') ?? 'Copy value').toBeLessThanOrEqual(1);
  }
  await detail.getByRole('button', { name: 'Copy baseline value for total_spend', exact: true }).click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('1.0');
  await detail.getByRole('button', { name: 'Copy candidate value for note', exact: true }).click();
  await expect.poll(() => page.evaluate(async () => (await navigator.clipboard.readText()).replaceAll('\r\n', '\n'))).toBe('Updated first line\nUpdated second line');
});

test('preserves cleanup defects when closing a source and permits a successful retry', { tag: '@dev' }, async ({ page }, testInfo) => {
  const diagnostics: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('message=csv.close')) diagnostics.push(message.text());
  });
  // Fail one snapshot deletion at the engine boundary; the real close and retry still run.
  await page.route((url) => url.pathname === '/src/duckdb-wasm-database.ts', async (route) => {
    const response = await route.fetch();
    const source = await response.text();
    const anchor = 'run(sql, values) {';
    expect(source).toContain(anchor);
    await route.fulfill({ response, body: `let failSnapshotDrop = true;\n${source}`.replace(anchor, `${anchor}
      if (failSnapshotDrop && sql.startsWith('DROP TABLE IF EXISTS "csv_comparison_')) {
        failSnapshotDrop = false;
        return Effect.die(new Error('PRIVATE snapshot release defect'));
      }
    `) });
  });
  await page.goto('/');
  await openCsv(page, 'baseline.csv', 'id,value\n1,Ada\n');
  await openCsv(page, 'candidate.csv', 'id,value\n1,Grace\n');
  await compare(page);
  await page.getByRole('checkbox', { name: 'id', exact: true }).check();
  await page.getByRole('button', { name: 'Apply key', exact: true }).click();
  await expect(page.getByText('Changed 1', { exact: true })).toBeVisible();
  const close = page.getByRole('button', { name: 'Close baseline.csv', exact: true });
  const confirmed = page.waitForEvent('dialog').then((dialog) => dialog.accept());
  await close.click();
  await confirmed;
  await expect(page.getByRole('alert')).toContainText('Unable to close the Working CSV and all dependent Comparisons.');
  await expect(page.getByRole('tab')).toHaveCount(3);
  await expect(page.locator('body')).not.toContainText('PRIVATE');
  const failedCloseScreenshot = testInfo.outputPath('failed-close.png');
  await page.screenshot({ path: failedCloseScreenshot });
  await testInfo.attach('failed-close', { path: failedCloseScreenshot, contentType: 'image/png' });
  await testInfo.attach('close diagnostics', { body: diagnostics.join('\n'), contentType: 'text/plain' });
  expect(diagnostics.some((line) => line.includes('outcome=failed') && line.includes('defect=true'))).toBe(true);
  expect(diagnostics.join('')).not.toContain('PRIVATE');

  const retried = page.waitForEvent('dialog').then((dialog) => dialog.accept());
  await close.click();
  await retried;
  await expect(page.getByRole('tab')).toHaveCount(1);
  await expect(page.getByRole('tab', { name: 'candidate.csv', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('gridcell', { name: 'Grace', exact: true })).toBeVisible();
});

test('shows aligned differences, swaps sides, and refreshes an outdated result after editing', async ({ page }) => {
  await page.goto('/');
  await openCsv(page, 'baseline.csv', 'id,value\n1,Old\n2,Same\n3,Only baseline\n');
  await openCsv(page, 'candidate.csv', 'id,value\n1,New\n2,Same\n4,Only candidate\n5,More candidate\n');
  await compare(page);
  const comparison = page.getByRole('region', { name: 'CSV comparison', exact: true });
  await page.getByRole('checkbox', { name: 'id', exact: true }).check();
  await page.getByRole('button', { name: 'Apply key', exact: true }).click();
  for (const badge of ['Changed 1', 'Baseline-only 1', 'Candidate-only 2', 'Unchanged 1']) {
    await expect(comparison.getByText(badge, { exact: true })).toBeVisible();
  }
  await comparison.getByRole('button', { name: 'Grid', exact: true }).click();
  const grid = comparison.getByRole('grid', { name: 'Aligned comparison results' });
  await expect(grid.getByRole('gridcell', { name: /baseline changed value: Old/ })).toBeVisible();
  await expect(comparison.getByRole('gridcell', { name: /candidate changed value: New/ })).toBeVisible();
  await expect(grid.getByRole('gridcell', { name: 'Baseline-only', exact: true })).toHaveCount(1);
  await expect(grid.getByRole('gridcell', { name: 'Candidate-only', exact: true })).toHaveCount(2);
  await expect(grid.getByRole('gridcell', { name: 'Same', exact: true })).toHaveCount(0);
  await comparison.getByRole('button', { name: /^All rows / }).click();
  await expect(grid.getByRole('gridcell', { name: 'Same', exact: true })).toHaveCount(1);
  await comparison.getByRole('button', { name: /^Differences / }).click();
  await expect(grid.getByRole('gridcell', { name: 'Same', exact: true })).toHaveCount(0);
  await comparison.getByRole('button', { name: 'Swap sides', exact: true }).click();
  await expect(comparison.getByText('Baseline-only 2', { exact: true })).toBeVisible();
  await expect(comparison.getByText('Candidate-only 1', { exact: true })).toBeVisible();
  await expect(comparison.getByRole('gridcell', { name: /baseline changed value: New/ })).toBeVisible();
  await comparison.getByRole('button', { name: 'Swap sides', exact: true }).click();
  await expect(comparison.getByText('Baseline-only 1', { exact: true })).toBeVisible();

  await page.getByRole('tab', { name: 'candidate.csv', exact: true }).click();
  await editCell(page, 'value', 0, 'Old');
  await page.getByRole('tab', { name: /baseline.csv.*candidate.csv/ }).click();
  await expect(comparison.getByText('Outdated Comparison.', { exact: true })).toBeVisible();
  await expect(comparison.getByText('Changed 1', { exact: true })).toBeVisible();
  await comparison.getByRole('button', { name: 'Refresh comparison', exact: true }).click();
  await expect(comparison.getByText('Changed 0', { exact: true })).toBeVisible();
  await expect(comparison.getByText('Unchanged 2', { exact: true })).toBeVisible();
  await expect(comparison.getByText('Outdated Comparison.', { exact: true })).toHaveCount(0);
  await expect(grid.getByRole('gridcell', { name: 'Changed', exact: true })).toHaveCount(0);
});

test('rejects duplicate keys then applies a composite key across complete sources', async ({ page }) => {
  await page.goto('/');
  await openCsv(page, 'baseline.csv', 'team,id,value\ncompiler,1,Ada\ncompiler,2,Grace\n');
  // A source query must never hide duplicate keys from comparison validation.
  await page.getByRole('searchbox', { name: 'Global search' }).fill('Ada');
  await expect(page.getByText('1 visible of 2 rows', { exact: true })).toBeVisible();
  await openCsv(page, 'candidate.csv', 'team,id,value\ncompiler,1,Ada\ncompiler,2,Grace edited\n');
  await compare(page);
  await page.getByRole('checkbox', { name: 'team', exact: true }).check();
  await page.getByRole('button', { name: 'Apply key', exact: true }).click();
  const alert = page.getByRole('alert');
  await expect(alert).toBeFocused();
  await expect(alert).toContainText('This draft is not a Valid Comparison Key.');
  await expect(alert).toContainText('baseline.csv: 0 blank-key rows, 1 duplicate-key groups');
  await alert.getByText('Show bounded examples', { exact: true }).first().click();
  await expect(alert).toContainText('Key compiler appears 2 times');
  await page.getByRole('checkbox', { name: 'id', exact: true }).check();
  await expect(alert).toHaveCount(0);
  await page.getByRole('button', { name: 'Move id earlier', exact: true }).click();
  await page.getByRole('button', { name: 'Apply key', exact: true }).click();
  await expect(page.getByLabel('Applied key: id + team', { exact: true })).toBeVisible();
  await expect(page.getByText('Changed 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Unchanged 1', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Selected comparison row' }).getByRole('cell', { name: /candidate changed value: Grace edited/ })).toBeVisible();
});

test('reports blank keys with evidence rather than publishing a partial result', async ({ page }) => {
  await page.goto('/');
  await openCsv(page, 'baseline.csv', 'id,value\n1,Ada\n,Grace\n');
  await openCsv(page, 'candidate.csv', 'id,value\n1,Ada\n2,Grace\n');
  await compare(page);
  await page.getByRole('checkbox', { name: 'id', exact: true }).check();
  await page.getByRole('button', { name: 'Apply key', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('baseline.csv: 1 blank-key rows, 0 duplicate-key groups');
  await page.getByText('Show bounded examples', { exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Row 2: Null');
  await expect(page.getByText('Changed 0', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Refresh comparison', exact: true })).toBeDisabled();
});

test('shares filters, search, and row selection between scanning and inspection', async ({ page }) => {
  await page.goto('/');
  await openCsv(page, 'baseline.csv', 'id,value,note\n9,Same,Keep\n7,Old,Hidden note\n2,Removed,Elsewhere\n');
  await openCsv(page, 'candidate.csv', 'id,value,note\n3,Added,Elsewhere\n7,New,Hidden note\n9,Same,Keep\n');
  await compare(page);
  const comparison = page.getByRole('region', { name: 'CSV comparison', exact: true });
  await comparison.getByRole('checkbox', { name: 'id', exact: true }).check();
  await comparison.getByRole('button', { name: 'Apply key', exact: true }).click();
  const detail = comparison.getByRole('region', { name: 'Selected comparison row' });
  await expect(detail.getByRole('heading', { name: 'id 7', exact: true })).toBeVisible();
  await expect(detail.getByRole('rowheader', { name: 'note', exact: true })).toHaveCount(0);
  await comparison.getByRole('button', { name: 'Grid', exact: true }).click();
  const grid = comparison.getByRole('grid', { name: 'Aligned comparison results' });
  await expect(grid.getByRole('columnheader', { name: 'note', exact: true })).toHaveCount(0);
  await comparison.getByRole('checkbox', { name: 'Changed fields only' }).uncheck();
  await expect(grid.getByRole('columnheader', { name: 'note', exact: true })).toBeVisible();
  await comparison.getByRole('combobox', { name: 'Row order' }).selectOption('csv-order');
  await comparison.getByRole('button', { name: /^All rows / }).click();
  const keyCell = grid.getByRole('gridcell', { name: /^id 9 Press Enter/ });
  await keyCell.focus();
  await keyCell.press('Enter');
  await expect(detail).toBeFocused();
  await expect(detail.getByRole('heading', { name: 'id 9', exact: true })).toBeVisible();
  await comparison.getByRole('button', { name: 'Next row', exact: true }).click();
  await expect(detail.getByRole('heading', { name: 'id 7', exact: true })).toBeVisible();
  await comparison.getByRole('button', { name: 'Grid', exact: true }).click();
  await expect(grid.locator('.comparison-selected-row [col-id="key"]')).toContainText('id 7');
  const search = comparison.getByRole('searchbox', { name: 'Find a comparison row or value' });
  await search.fill('HIDDEN NOTE');
  await expect(comparison.getByText('1 of 4 rows', { exact: true })).toBeVisible();
  await comparison.getByRole('button', { name: 'Inspector', exact: true }).click();
  await expect(search).toHaveValue('HIDDEN NOTE');
  await expect(detail.getByRole('heading', { name: 'id 7', exact: true })).toBeVisible();
  await comparison.getByRole('button', { name: /^Unchanged / }).click();
  await expect(comparison.getByText('No matching rows', { exact: true })).toBeVisible();
  await search.fill('Keep');
  await expect(detail.getByRole('heading', { name: 'id 9', exact: true })).toBeVisible();
  await search.clear();
  await comparison.getByRole('button', { name: 'Edit key', exact: true }).click();
  const editor = page.getByRole('dialog', { name: 'Edit Comparison Key' });
  await editor.getByRole('checkbox', { name: 'note', exact: true }).check();
  await editor.getByRole('button', { name: 'Apply key', exact: true }).click();
  await expect(editor).toHaveCount(0);
  await expect(comparison.getByLabel('Applied key: id + note', { exact: true })).toBeVisible();
});

test('keeps the selected row while typing and applies search after a pause', async ({ page }) => {
  await page.goto('/');
  await openCsv(page, 'baseline.csv', 'id,value\n1,Old\n2,Other\n');
  await openCsv(page, 'candidate.csv', 'id,value\n1,New\n2,Other\n');
  await compare(page);
  await page.getByRole('checkbox', { name: 'id', exact: true }).check();
  await page.getByRole('button', { name: 'Apply key', exact: true }).click();
  const detail = page.getByRole('region', { name: 'Selected comparison row' });
  await expect(detail.getByRole('heading', { name: 'id 1', exact: true })).toBeVisible();
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const search = page.getByRole('searchbox', { name: 'Find a comparison row or value' });
  await search.fill('N');
  await expect(detail.getByRole('heading', { name: 'id 1', exact: true })).toBeVisible();
  await search.fill('New');
  await page.clock.fastForward(149);
  await expect(detail.getByRole('heading', { name: 'id 1', exact: true })).toBeVisible();
  await page.clock.resume();
  await expect(page.getByText('1 of 2 rows', { exact: true })).toBeVisible();
  await expect(detail.getByRole('cell', { name: /candidate changed value: New/ })).toBeVisible();
});

test('discards a replaced comparison read and loads the next applied result', { tag: '@dev' }, async ({ page }) => {
  // Deliver the service's expected stale-result outcome before its replacement projection arrives.
  await page.route(url => url.pathname.endsWith('/comparison/csv-comparison-service.ts'), async route => {
    const response = await route.fetch();
    const source = await response.text();
    const anchor = 'if (!snapshot || snapshot.resultToken !== request.resultToken) {';
    expect(source).toContain(anchor);
    await route.fulfill({ response, body: source.replace(anchor, `
      if (document.body.dataset.replaceComparisonRead === 'true' || !snapshot || snapshot.resultToken !== request.resultToken) {
        delete document.body.dataset.replaceComparisonRead;
        document.body.dataset.replacedComparisonRead = 'true';
    `) });
  });
  await page.goto('/');
  await openCsv(page, 'baseline.csv', 'id,value\n1,Old\n2,Same\n');
  await openCsv(page, 'candidate.csv', 'id,value\n1,New\n2,Same\n');
  await compare(page);
  await page.getByRole('checkbox', { name: 'id', exact: true }).check();
  await page.getByRole('button', { name: 'Apply key', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Selected comparison row' }).getByRole('heading', { name: 'id 1' })).toBeVisible();
  await page.evaluate(() => { document.body.dataset.replaceComparisonRead = 'true'; });
  await page.getByRole('button', { name: /^All rows / }).click();
  await expect(page.locator('body')).toHaveAttribute('data-replaced-comparison-read', 'true');
  await expect(page.getByRole('alert')).toHaveCount(0);
  await page.getByRole('button', { name: 'Refresh comparison', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Selected comparison row' }).getByRole('heading', { name: 'id 1' })).toBeVisible();
  await expect(page.getByText('2 of 2 rows', { exact: true })).toBeVisible();
});

test('inspects across page boundaries and preserves grid scroll and widths across views and search', async ({ page }, testInfo) => {
  await page.goto('/');
  const baseline = Array.from({ length: 205 }, (_, index) => `${index + 1},Old ${index + 1},Before A,Before B,Before C,Before D`).join('\n');
  const candidate = Array.from({ length: 205 }, (_, index) => `${index + 1},New ${index + 1},After A,After B,After C,After D`).join('\n');
  await openCsv(page, 'baseline.csv', `id,value,a,b,c,d\n${baseline}\n`);
  await openCsv(page, 'candidate.csv', `id,value,a,b,c,d\n${candidate}\n`);
  await compare(page);
  await page.getByRole('checkbox', { name: 'id', exact: true }).check();
  await page.getByRole('button', { name: 'Apply key', exact: true }).click();
  await page.getByRole('button', { name: 'Grid', exact: true }).click();
  const grid = page.getByRole('grid', { name: 'Aligned comparison results' });
  // Headers mount before the first row; wait for the usable grid before resizing and scrolling.
  await expect(grid.getByRole('gridcell', { name: /^id 1 Press Enter/ })).toBeVisible();
  const valueHeader = grid.locator('.ag-header-cell[col-id="value:value"]');
  const resize = await valueHeader.locator('.ag-header-cell-resize').boundingBox();
  if (!resize) throw new Error('Missing value column resize handle.');
  await page.mouse.move(resize.x + resize.width / 2, resize.y + resize.height / 2);
  await page.mouse.down();
  await page.mouse.move(resize.x + 90, resize.y + resize.height / 2);
  await page.mouse.up();
  const width = await valueHeader.evaluate(element => element.getBoundingClientRect().width);
  expect(width).toBeGreaterThan(300);
  await grid.locator('.ag-body-horizontal-scroll-viewport').evaluate(element => { element.scrollLeft = 140; });
  await expect.poll(() => grid.locator('.ag-center-cols-viewport').evaluate(element => element.scrollLeft)).toBe(140);
  await grid.locator('.ag-body-viewport').evaluate(element => { element.scrollTop = 98 * 44; });
  await expect(grid.getByRole('gridcell', { name: /^id 100 Press Enter/ })).toBeVisible();
  const scrollTop = await grid.locator('.ag-body-viewport').evaluate(element => element.scrollTop);
  await grid.getByRole('gridcell', { name: /^id 100 Press Enter/ }).click();
  const detail = page.getByRole('region', { name: 'Selected comparison row' });
  await expect(detail.getByText('Row 100 of 205', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Next row', exact: true }).click();
  await expect(detail.getByRole('heading', { name: 'id 101', exact: true })).toBeVisible();
  await expect(detail.getByRole('cell', { name: /candidate changed value: New 101/ })).toBeVisible();
  const inspectorScreenshot = testInfo.outputPath('comparison-inspector.png');
  await page.screenshot({ path: inspectorScreenshot });
  await testInfo.attach('comparison inspector', { path: inspectorScreenshot, contentType: 'image/png' });
  await page.getByRole('button', { name: 'Grid', exact: true }).click();
  await expect(grid.locator('.comparison-selected-row [col-id="key"]')).toContainText('id 101');
  await expect(page.getByRole('region', { name: 'CSV comparison' }).locator('.ag-root-wrapper')).toHaveCount(1);
  await expect.poll(() => grid.locator('.ag-body-viewport').evaluate(element => element.scrollTop)).toBe(scrollTop);
  await expect.poll(() => grid.locator('.ag-body-horizontal-scroll-viewport').evaluate(element => element.scrollLeft)).toBe(140);
  await expect.poll(() => grid.locator('.ag-center-cols-viewport').evaluate(element => element.scrollLeft)).toBe(140);
  await expect.poll(() => grid.locator('.ag-header-viewport').evaluate(element => element.scrollLeft)).toBe(140);
  expect(await valueHeader.evaluate(element => element.getBoundingClientRect().width)).toBe(width);
  await page.getByRole('searchbox', { name: 'Find a comparison row or value' }).fill('New 10');
  await expect(page.getByText('11 of 205 rows', { exact: true })).toBeVisible();
  expect(await valueHeader.evaluate(element => element.getBoundingClientRect().width)).toBe(width);
  const screenshot = testInfo.outputPath('comparison-grid-retained-width.png');
  await page.screenshot({ path: screenshot });
  await testInfo.attach('comparison grid', { path: screenshot, contentType: 'image/png' });
});
