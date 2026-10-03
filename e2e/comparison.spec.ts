import { expect, test, type Page } from '@playwright/test';
import { editCell, openCsv } from './helpers/csv';

async function compare(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'baseline.csv', exact: true }).click();
  await page.getByRole('button', { name: 'Compare…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose a Candidate' }).getByRole('button', { name: /candidate.csv/ }).click();
  await expect(page.getByRole('region', { name: 'CSV comparison', exact: true })).toBeVisible();
}

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
  await expect(comparison.getByRole('gridcell', { name: /baseline changed value: Old/ })).toBeVisible();
  await expect(comparison.getByRole('gridcell', { name: /candidate changed value: New/ })).toBeVisible();
  await expect(comparison.getByRole('gridcell', { name: /Missing candidate row/ })).toHaveCount(1);
  await expect(comparison.getByRole('gridcell', { name: /Missing baseline row/ })).toHaveCount(2);
  await expect(comparison.getByRole('gridcell', { name: /^Same / })).toHaveCount(0);
  await comparison.getByRole('button', { name: 'All rows', exact: true }).click();
  await expect(comparison.getByRole('gridcell', { name: /^Same / })).toHaveCount(2);
  await comparison.getByRole('button', { name: 'Differences', exact: true }).click();
  await expect(comparison.getByRole('gridcell', { name: /^Same / })).toHaveCount(0);
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
  await expect(comparison.getByRole('gridcell', { name: /changed value:/ })).toHaveCount(0);
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
  await expect(page.getByText('Applied key: id + team', { exact: true })).toBeVisible();
  await expect(page.getByText('Changed 1', { exact: true })).toBeVisible();
  await expect(page.getByText('Unchanged 1', { exact: true })).toBeVisible();
  await expect(page.getByRole('gridcell', { name: /candidate changed value: Grace edited/ })).toBeVisible();
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
