// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { CsvTab } from './csv-tab';
import { workingCsvFixture } from '../test-helpers/csv-views';
import { createTestCsvViewer, withCsvViewer } from '../test-helpers/csv-viewer';
import { CsvGrid, isCopyColumnShortcut } from './csv-grid';

const DataGrid = () => null;

afterEach(cleanup);

describe('CsvGrid', () => {
  it('shows source size in decimal MB to match capacity limits', () => {
    const workingCsv = workingCsvFixture();
    workingCsv.source.sizeBytes = 100_000_000;
    const tab = new CsvTab(createTestCsvViewer(), workingCsv);

    render(withCsvViewer(<CsvGrid tab={tab} themeMode="light" DataGrid={DataGrid} />));

    expect(screen.getByText('100.0 MB')).toBeDefined();
  });

  it('presents Unexported Changes using the product language', () => {
    const workingCsv = workingCsvFixture({
      editState: { workingCsvId: 'working-csv-1', hasUnexportedChanges: true, canUndo: true, canRedo: false },
    });
    const tab = new CsvTab(createTestCsvViewer(), workingCsv);

    render(withCsvViewer(<CsvGrid tab={tab} themeMode="light" DataGrid={DataGrid} />));

    expect(screen.getByText('Unexported Changes')).toBeDefined();
  });

  it('allows relative row insertion with one selected row while a query is active', () => {
    const tab = new CsvTab(createTestCsvViewer(), workingCsvFixture());
    tab.setSearch('ada');
    tab.setSelection(['row-1']);

    render(withCsvViewer(<CsvGrid tab={tab} themeMode="light" DataGrid={DataGrid} />));

    expect(screen.getByRole('button', { name: 'Insert row above' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Insert row below' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Append row' }).hasAttribute('disabled')).toBe(true);
  });

  it('opens the Stats Panel through the CSV Tab and shows its Column Value Counts', async () => {
    const workingCsv = workingCsvFixture();
    const tab = new CsvTab(
      createTestCsvViewer({
        handlers: {
          'csv.get-column-value-counts': async () => ({
            workingCsvId: workingCsv.workingCsvId,
            column: 'id',
            scopeRowCount: 1,
            values: [{ value: 'ada', count: 1, percentOfScope: 100 }],
          }),
        },
      }),
      workingCsv,
    );

    render(withCsvViewer(<CsvGrid tab={tab} themeMode="light" DataGrid={DataGrid} />));
    await act(async () => {
      screen.getByRole('button', { name: 'Open stats panel' }).click();
    });

    expect(tab.snapshot().stats).toMatchObject({ open: true, column: 'id' });
    expect(screen.getByRole('complementary', { name: 'Stats Panel' })).toBeDefined();
    expect(screen.getByText('1 scoped rows')).toBeDefined();
  });

  it('presents the runtime-specific confirmation after Export CSV succeeds', async () => {
    const workingCsv = workingCsvFixture({
      editState: { workingCsvId: 'working-csv-1', hasUnexportedChanges: true, canUndo: true, canRedo: false },
    });
    const tab = new CsvTab(
      createTestCsvViewer({
        capabilities: { exportCsvSuccessMessage: 'Download started' },
        handlers: {
          'csv.export': async () => ({
            status: 'exported',
            editState: { ...workingCsv.editState, hasUnexportedChanges: false },
          }),
        },
      }),
      workingCsv,
    );

    render(withCsvViewer(<CsvGrid tab={tab} themeMode="light" DataGrid={DataGrid} />));

    await act(async () => {
      screen.getByRole('button', { name: 'Export CSV' }).click();
    });

    expect(screen.getByRole('status').textContent).toBe('Download started');
  });

  it('offers Rename column for the focused column', async () => {
    const tab = new CsvTab(createTestCsvViewer(), workingCsvFixture());
    tab.setFocusedColumn('id');

    render(withCsvViewer(<CsvGrid tab={tab} themeMode="light" DataGrid={DataGrid} />));

    expect(screen.getByRole('button', { name: 'Rename column' })).toBeDefined();
    await act(async () => {
      screen.getByRole('button', { name: 'Rename column' }).click();
    });
    expect(screen.getByRole('textbox', { name: 'Column name' })).toBeDefined();
  });

  it('treats Ctrl+C or Cmd+C alone as the Copy column shortcut', () => {
    const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { key: 'c', ...init });

    expect(isCopyColumnShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isCopyColumnShortcut(key({ metaKey: true }))).toBe(true);
    expect(isCopyColumnShortcut(key({}))).toBe(false);
    expect(isCopyColumnShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
  });
});
