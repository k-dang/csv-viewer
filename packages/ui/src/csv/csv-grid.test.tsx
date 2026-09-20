// @vitest-environment jsdom
import { useEffect } from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { AgGridReactProps } from 'ag-grid-react';
import type { GridReadyEvent } from 'ag-grid-community';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CsvRow } from '@csv-viewer/workspace/csv-viewer';
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

  it('keeps grid column fields in Working CSV order after renaming a middle header', async () => {
    const workingCsv = workingCsvFixture({
      columns: [
        { name: 'id', type: 'VARCHAR' },
        { name: 'email', type: 'VARCHAR' },
        { name: 'status', type: 'VARCHAR' },
      ],
    });
    const renamedColumns = [
      { name: 'id', type: 'VARCHAR' },
      { name: 'work_email', type: 'VARCHAR' },
      { name: 'status', type: 'VARCHAR' },
    ];
    const tab = new CsvTab(
      createTestCsvViewer({
        handlers: {
          'csv.rename-column': async () => ({
            workingCsvId: workingCsv.workingCsvId,
            columns: renamedColumns,
            hasUnexportedChanges: true,
            canUndo: true,
            canRedo: false,
          }),
        },
      }),
      workingCsv,
    );
    tab.setFocusedColumn('email');
    let latest: AgGridReactProps<CsvRow> | undefined;
    const CaptureGrid = (props: AgGridReactProps<CsvRow>) => {
      latest = props;
      return null;
    };

    const { rerender } = render(withCsvViewer(<CsvGrid tab={tab} themeMode="light" DataGrid={CaptureGrid} />));
    expect(fieldNames(latest?.columnDefs)).toEqual(['id', 'email', 'status']);
    expect(latest?.maintainColumnOrder).toBeFalsy();

    await act(async () => {
      await tab.renameFocusedColumn('work_email');
    });
    rerender(withCsvViewer(<CsvGrid tab={tab} themeMode="light" DataGrid={CaptureGrid} />));

    expect(fieldNames(latest?.columnDefs)).toEqual(['id', 'work_email', 'status']);
    expect(latest?.maintainColumnOrder).toBeFalsy();
  });

  it('reapplies sort and filter under the renamed column id', async () => {
    const workingCsv = workingCsvFixture({
      columns: [
        { name: 'id', type: 'VARCHAR' },
        { name: 'email', type: 'VARCHAR' },
      ],
    });
    const renamedColumns = [
      { name: 'id', type: 'VARCHAR' },
      { name: 'work_email', type: 'VARCHAR' },
    ];
    const applyColumnState = vi.fn();
    const setFilterModel = vi.fn();
    const api = {
      applyColumnState,
      setFilterModel,
      getColumnState: () => [
        { colId: 'email', sort: 'asc' as const },
        { colId: 'id' },
      ],
      getFilterModel: () => ({ email: { filterType: 'text' as const, type: 'contains', filter: 'ada' } }),
      refreshInfiniteCache: vi.fn(),
      deselectAll: vi.fn(),
    };
    const tab = new CsvTab(
      createTestCsvViewer({
        handlers: {
          'csv.rename-column': async () => ({
            workingCsvId: workingCsv.workingCsvId,
            columns: renamedColumns,
            hasUnexportedChanges: true,
            canUndo: true,
            canRedo: false,
          }),
        },
      }),
      workingCsv,
    );
    tab.setFocusedColumn('email');
    tab.setGridQuery(
      [{ column: 'email', direction: 'asc' }],
      [{ column: 'email', kind: 'text', operator: 'contains', value: 'ada' }],
    );
    const ReadyGrid = (props: AgGridReactProps<CsvRow>) => {
      useEffect(() => {
        props.onGridReady?.({ api } as unknown as GridReadyEvent<CsvRow>);
      }, [props]);
      return null;
    };

    render(withCsvViewer(<CsvGrid tab={tab} themeMode="light" DataGrid={ReadyGrid} />));
    await act(async () => {
      await tab.renameFocusedColumn('work_email');
    });

    expect(tab.snapshot().query.sort).toEqual([{ column: 'work_email', direction: 'asc' }]);
    expect(tab.snapshot().query.filters).toEqual([
      { column: 'work_email', kind: 'text', operator: 'contains', value: 'ada' },
    ]);
    expect(applyColumnState).toHaveBeenCalledWith({
      state: [
        { colId: 'work_email', sort: 'asc' },
        { colId: 'id' },
      ],
    });
    expect(setFilterModel).toHaveBeenCalledWith({
      work_email: { filterType: 'text', type: 'contains', filter: 'ada' },
    });
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

  it('closes Rename column when the focused column changes', async () => {
    const tab = new CsvTab(
      createTestCsvViewer(),
      workingCsvFixture({
        columns: [
          { name: 'id', type: 'VARCHAR' },
          { name: 'email', type: 'VARCHAR' },
        ],
      }),
    );
    tab.setFocusedColumn('id');

    render(withCsvViewer(<CsvGrid tab={tab} themeMode="light" DataGrid={DataGrid} />));
    await act(async () => {
      screen.getByRole('button', { name: 'Rename column' }).click();
    });
    expect(screen.getByRole('textbox', { name: 'Column name' })).toBeDefined();

    await act(async () => {
      tab.setFocusedColumn('email');
    });
    expect(screen.queryByRole('textbox', { name: 'Column name' })).toBeNull();
    expect(screen.getByText('email')).toBeDefined();
  });

  it('treats Ctrl+C or Cmd+C alone as the Copy column shortcut', () => {
    const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', { key: 'c', ...init });

    expect(isCopyColumnShortcut(key({ ctrlKey: true }))).toBe(true);
    expect(isCopyColumnShortcut(key({ metaKey: true }))).toBe(true);
    expect(isCopyColumnShortcut(key({}))).toBe(false);
    expect(isCopyColumnShortcut(key({ ctrlKey: true, shiftKey: true }))).toBe(false);
  });
});

function fieldNames(columnDefs: AgGridReactProps<CsvRow>['columnDefs']): string[] {
  if (!columnDefs) return [];
  return columnDefs.flatMap((column) => ('field' in column && column.field ? [String(column.field)] : []));
}
