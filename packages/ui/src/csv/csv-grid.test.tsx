// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import type { AgGridReactProps } from 'ag-grid-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CsvRow } from '@csv-viewer/workspace/csv-viewer';
import { CsvTab } from './csv-tab';
import { workingCsvFixture } from '../test-helpers/csv-views';
import { createTestCsvViewer, withCsvViewer } from '../test-helpers/csv-viewer';
import { CsvGrid } from './csv-grid';
import { isCopyCellShortcut, isCopyColumnShortcut } from './copy-column';

const DataGrid = () => null;

afterEach(cleanup);

describe('CsvGrid', () => {
  it('shows source size in decimal MB to match capacity limits', () => {
    const workingCsv = workingCsvFixture();
    workingCsv.source.sizeBytes = 100_000_000;
    const tab = new CsvTab(createTestCsvViewer(), workingCsv);

    render(withCsvViewer(<CsvGrid tab={tab} active DataGrid={DataGrid} />));

    expect(screen.getByText('100.0 MB')).toBeDefined();
  });

  it('presents Unexported Changes using the product language', () => {
    const workingCsv = workingCsvFixture({
      editState: { workingCsvId: 'working-csv-1', hasUnexportedChanges: true, canUndo: true, canRedo: false },
    });
    const tab = new CsvTab(createTestCsvViewer(), workingCsv);

    render(withCsvViewer(<CsvGrid tab={tab} active DataGrid={DataGrid} />));

    expect(screen.getByText('Unexported Changes')).toBeDefined();
  });

  it('allows relative row insertion with one selected row while a query is active', () => {
    const tab = new CsvTab(createTestCsvViewer(), workingCsvFixture());
    tab.setSearch('ada');
    tab.setSelection(['row-1']);

    render(withCsvViewer(<CsvGrid tab={tab} active DataGrid={DataGrid} />));

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

    render(withCsvViewer(<CsvGrid tab={tab} active DataGrid={DataGrid} />));
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

    render(withCsvViewer(<CsvGrid tab={tab} active DataGrid={DataGrid} />));

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

    const { rerender } = render(withCsvViewer(<CsvGrid tab={tab} active DataGrid={CaptureGrid} />));
    expect(fieldNames(latest?.columnDefs)).toEqual(['id', 'email', 'status']);
    expect(latest?.maintainColumnOrder).toBeFalsy();

    await act(async () => {
      await tab.renameFocusedColumn('work_email');
    });
    rerender(withCsvViewer(<CsvGrid tab={tab} active DataGrid={CaptureGrid} />));

    expect(fieldNames(latest?.columnDefs)).toEqual(['id', 'work_email', 'status']);
    expect(latest?.maintainColumnOrder).toBeFalsy();
  });

  it('keeps grid column fields in Working CSV order after a middle insert and a delete', async () => {
    const workingCsv = workingCsvFixture({
      columns: [
        { name: 'id', type: 'VARCHAR' },
        { name: 'email', type: 'VARCHAR' },
        { name: 'status', type: 'VARCHAR' },
      ],
    });
    const insertedColumns = [
      { name: 'id', type: 'VARCHAR' },
      { name: 'email', type: 'VARCHAR' },
      { name: 'New column', type: 'VARCHAR' },
      { name: 'status', type: 'VARCHAR' },
    ];
    const deletedColumns = [
      { name: 'id', type: 'VARCHAR' },
      { name: 'New column', type: 'VARCHAR' },
      { name: 'status', type: 'VARCHAR' },
    ];
    const tab = new CsvTab(
      createTestCsvViewer({
        handlers: {
          'csv.insert-column': async () => ({
            workingCsvId: workingCsv.workingCsvId,
            columns: insertedColumns,
            hasUnexportedChanges: true,
            canUndo: true,
            canRedo: false,
          }),
          'csv.delete-column': async () => ({
            workingCsvId: workingCsv.workingCsvId,
            columns: deletedColumns,
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

    const { rerender } = render(withCsvViewer(<CsvGrid tab={tab} active DataGrid={CaptureGrid} />));

    await act(async () => {
      await tab.insertColumn('after');
    });
    rerender(withCsvViewer(<CsvGrid tab={tab} active DataGrid={CaptureGrid} />));
    expect(fieldNames(latest?.columnDefs)).toEqual(['id', 'email', 'New column', 'status']);
    expect(latest?.maintainColumnOrder).toBeFalsy();

    await act(async () => {
      await tab.deleteFocusedColumn();
    });
    rerender(withCsvViewer(<CsvGrid tab={tab} active DataGrid={CaptureGrid} />));
    expect(fieldNames(latest?.columnDefs)).toEqual(['id', 'New column', 'status']);
    expect(latest?.maintainColumnOrder).toBeFalsy();
  });

  it('inserts on either side of a focused column and deletes it when more than one column remains', async () => {
    const workingCsv = workingCsvFixture({
      columns: [
        { name: 'id', type: 'VARCHAR' },
        { name: 'email', type: 'VARCHAR' },
      ],
    });
    const insertColumn = vi.fn(async () => ({
      workingCsvId: workingCsv.workingCsvId,
      columns: workingCsv.columns,
      hasUnexportedChanges: true,
      canUndo: true,
      canRedo: false,
    }));
    const deleteColumn = vi.fn(async () => ({
      workingCsvId: workingCsv.workingCsvId,
      columns: [{ name: 'email', type: 'VARCHAR' }],
      hasUnexportedChanges: true,
      canUndo: true,
      canRedo: false,
    }));
    const tab = new CsvTab(
      createTestCsvViewer({ handlers: { 'csv.insert-column': insertColumn, 'csv.delete-column': deleteColumn } }),
      workingCsv,
    );
    tab.setFocusedColumn('id');

    render(withCsvViewer(<CsvGrid tab={tab} active DataGrid={DataGrid} />));

    const insertLeft = screen.getByRole('button', { name: 'Insert column left' });
    const deleteFocused = screen.getByRole('button', { name: 'Delete column' });
    expect(screen.getByRole('button', { name: 'Insert column right' })).toBeDefined();
    expect(deleteFocused.hasAttribute('disabled')).toBe(false);

    await act(async () => {
      insertLeft.click();
    });
    expect(insertColumn).toHaveBeenCalledWith({
      operation: 'csv.insert-column',
      workingCsvId: workingCsv.workingCsvId,
      column: 'id',
      placement: 'before',
    });

    await act(async () => {
      screen.getByRole('button', { name: 'Delete column' }).click();
    });
    expect(deleteColumn).toHaveBeenCalledWith({
      operation: 'csv.delete-column',
      workingCsvId: workingCsv.workingCsvId,
      column: 'id',
    });
  });

  it('ignores another column mutation while insert is pending', async () => {
    const workingCsv = workingCsvFixture({
      columns: [
        { name: 'id', type: 'VARCHAR' },
        { name: 'email', type: 'VARCHAR' },
      ],
    });
    const pending = Promise.withResolvers<{
      workingCsvId: string;
      columns: typeof workingCsv.columns;
      hasUnexportedChanges: boolean;
      canUndo: boolean;
      canRedo: boolean;
    }>();
    const insertColumn = vi.fn(() => pending.promise);
    const deleteColumn = vi.fn();
    const tab = new CsvTab(
      createTestCsvViewer({ handlers: { 'csv.insert-column': insertColumn, 'csv.delete-column': deleteColumn } }),
      workingCsv,
    );
    tab.setFocusedColumn('id');

    render(withCsvViewer(<CsvGrid tab={tab} active DataGrid={DataGrid} />));

    const insertLeft = screen.getByRole('button', { name: 'Insert column left' });
    const insertRight = screen.getByRole('button', { name: 'Insert column right' });
    const deleteFocused = screen.getByRole('button', { name: 'Delete column' });
    act(() => {
      insertLeft.click();
      insertRight.click();
      deleteFocused.click();
    });
    expect(insertColumn).toHaveBeenCalledTimes(1);
    expect(deleteColumn).not.toHaveBeenCalled();
    expect(insertLeft.hasAttribute('disabled')).toBe(true);
    expect(insertRight.hasAttribute('disabled')).toBe(true);
    expect(deleteFocused.hasAttribute('disabled')).toBe(true);

    await act(async () => {
      pending.resolve({
        workingCsvId: workingCsv.workingCsvId,
        columns: workingCsv.columns,
        hasUnexportedChanges: true,
        canUndo: true,
        canRedo: false,
      });
    });
    expect(insertLeft.hasAttribute('disabled')).toBe(false);
    expect(insertRight.hasAttribute('disabled')).toBe(false);
    expect(deleteFocused.hasAttribute('disabled')).toBe(false);
  });

  it('disables Delete column when the focused column is the only one', () => {
    const tab = new CsvTab(createTestCsvViewer(), workingCsvFixture());
    tab.setFocusedColumn('id');

    render(withCsvViewer(<CsvGrid tab={tab} active DataGrid={DataGrid} />));

    expect(screen.getByRole('button', { name: 'Insert column left' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Insert column right' }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: 'Delete column' }).hasAttribute('disabled')).toBe(true);
  });

  it('keeps the column placeholder when no column is focused', () => {
    const tab = new CsvTab(createTestCsvViewer(), workingCsvFixture());

    render(withCsvViewer(<CsvGrid tab={tab} active DataGrid={DataGrid} />));

    expect(screen.getByText('Select a cell to copy its column.')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Rename column' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Copy column' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Insert column left' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Insert column right' }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: 'Delete column' }).hasAttribute('disabled')).toBe(true);
  });

  it('offers Rename column for the focused column', async () => {
    const tab = new CsvTab(createTestCsvViewer(), workingCsvFixture());
    tab.setFocusedColumn('id');

    render(withCsvViewer(<CsvGrid tab={tab} active DataGrid={DataGrid} />));

    expect(screen.getByRole('button', { name: 'Rename column' })).toBeDefined();
    await act(async () => {
      screen.getByRole('button', { name: 'Rename column' }).click();
    });
    expect(screen.getByRole('textbox', { name: 'Column name' })).toBeDefined();
  });

  it('starts rename when F2 is pressed on a column header', async () => {
    const tab = new CsvTab(
      createTestCsvViewer(),
      workingCsvFixture({
        columns: [
          { name: 'id', type: 'VARCHAR' },
          { name: 'email', type: 'VARCHAR' },
        ],
      }),
    );
    render(withCsvViewer(<CsvGrid tab={tab} active DataGrid={DataGrid} />));
    const idHeader = columnHeader('id');
    const idLabel = idHeader.querySelector('span');
    if (!idLabel) throw new Error('missing header label');
    const idEvent = keydown('F2');
    await act(async () => {
      idLabel.dispatchEvent(idEvent);
    });

    expect(idEvent.defaultPrevented).toBe(true);
    expect(tab.snapshot().focusedColumn).toBe('id');
    expect(columnNameValue()).toBe('id');
    idHeader.remove();

    const emailHeader = columnHeader('email');
    const emailLabel = emailHeader.querySelector('span');
    if (!emailLabel) throw new Error('missing header label');
    await act(async () => {
      emailLabel.dispatchEvent(keydown('F2'));
    });
    expect(tab.snapshot().focusedColumn).toBe('email');
    expect(columnNameValue()).toBe('email');
    emailHeader.remove();
  });

  it('does not reopen rename when focus returns to the column F2 started', async () => {
    const tab = new CsvTab(
      createTestCsvViewer(),
      workingCsvFixture({
        columns: [
          { name: 'id', type: 'VARCHAR' },
          { name: 'email', type: 'VARCHAR' },
        ],
      }),
    );
    render(withCsvViewer(<CsvGrid tab={tab} active DataGrid={DataGrid} />));
    const header = columnHeader('id');
    await act(async () => {
      header.dispatchEvent(keydown('F2'));
    });
    expect(columnNameValue()).toBe('id');
    header.remove();

    await act(async () => {
      tab.setFocusedColumn('email');
    });
    expect(screen.queryByRole('textbox', { name: 'Column name' })).toBeNull();

    await act(async () => {
      tab.setFocusedColumn('id');
    });
    expect(screen.queryByRole('textbox', { name: 'Column name' })).toBeNull();
    expect(screen.getByText('id')).toBeDefined();
  });

  it('does not start rename when F2 is pressed away from a column header', async () => {
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

    render(withCsvViewer(<CsvGrid tab={tab} active DataGrid={DataGrid} />));

    const search = screen.getByRole('searchbox', { name: 'Global search' });
    const searchEvent = keydown('F2');
    await act(async () => {
      search.dispatchEvent(searchEvent);
    });
    expect(searchEvent.defaultPrevented).toBe(false);
    expect(screen.queryByRole('textbox', { name: 'Column name' })).toBeNull();
    expect(tab.snapshot().focusedColumn).toBe('id');

    const cell = document.createElement('div');
    cell.className = 'ag-cell';
    cell.setAttribute('col-id', 'email');
    cell.tabIndex = -1;
    document.body.append(cell);
    const cellEvent = keydown('F2');
    await act(async () => {
      cell.dispatchEvent(cellEvent);
    });
    expect(cellEvent.defaultPrevented).toBe(false);
    expect(screen.queryByRole('textbox', { name: 'Column name' })).toBeNull();
    expect(tab.snapshot().focusedColumn).toBe('id');
    cell.remove();

    const unknown = columnHeader('sku');
    const unknownEvent = keydown('F2');
    await act(async () => {
      unknown.dispatchEvent(unknownEvent);
    });
    expect(unknownEvent.defaultPrevented).toBe(false);
    expect(screen.queryByRole('textbox', { name: 'Column name' })).toBeNull();
    expect(tab.snapshot().focusedColumn).toBe('id');
    unknown.remove();

    const shifted = columnHeader('email');
    const shiftedEvent = keydown('F2', { shiftKey: true });
    await act(async () => {
      shifted.dispatchEvent(shiftedEvent);
    });
    expect(shiftedEvent.defaultPrevented).toBe(false);
    expect(screen.queryByRole('textbox', { name: 'Column name' })).toBeNull();
    shifted.remove();

    cleanup();
    render(withCsvViewer(<CsvGrid tab={tab} active={false} DataGrid={DataGrid} />));
    const inactiveHeader = columnHeader('email');
    await act(async () => {
      inactiveHeader.dispatchEvent(keydown('F2'));
    });
    expect(screen.queryByRole('textbox', { name: 'Column name' })).toBeNull();
    expect(tab.snapshot().focusedColumn).toBe('id');
    inactiveHeader.remove();
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

    render(withCsvViewer(<CsvGrid tab={tab} active DataGrid={DataGrid} />));
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

  it('splits Ctrl+C (copy cell) from Ctrl+Shift+A (copy column)', () => {
    const cell = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true });
    const column = new KeyboardEvent('keydown', { key: 'A', ctrlKey: true, shiftKey: true });
    const cmdColumn = new KeyboardEvent('keydown', { key: 'A', metaKey: true, shiftKey: true });
    const alt = new KeyboardEvent('keydown', { key: 'c', ctrlKey: true, altKey: true });
    const shiftC = new KeyboardEvent('keydown', { key: 'C', ctrlKey: true, shiftKey: true });

    expect(isCopyCellShortcut(cell)).toBe(true);
    expect(isCopyCellShortcut(new KeyboardEvent('keydown', { key: 'C', ctrlKey: true }))).toBe(true);
    expect(isCopyColumnShortcut(cell)).toBe(false);
    expect(isCopyColumnShortcut(column)).toBe(true);
    expect(isCopyColumnShortcut(cmdColumn)).toBe(true);
    expect(isCopyCellShortcut(column)).toBe(false);
    expect(isCopyCellShortcut(alt)).toBe(false);
    expect(isCopyColumnShortcut(alt)).toBe(false);
    expect(isCopyColumnShortcut(shiftC)).toBe(false);
    expect(isCopyCellShortcut(shiftC)).toBe(false);
  });
});

function columnHeader(name: string): HTMLDivElement {
  const header = document.createElement('div');
  header.className = 'ag-header-cell';
  header.setAttribute('role', 'columnheader');
  header.setAttribute('col-id', name);
  header.tabIndex = -1;
  const label = document.createElement('span');
  label.className = 'ag-header-cell-text';
  label.textContent = name;
  header.append(label);
  document.body.append(header);
  return header;
}

function keydown(key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  return new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init });
}

function columnNameValue(): string {
  const input = screen.getByRole('textbox', { name: 'Column name' });
  if (!(input instanceof HTMLInputElement)) throw new Error('Column name is not an input');
  return input.value;
}

function fieldNames(columnDefs: AgGridReactProps<CsvRow>['columnDefs']): string[] {
  if (!columnDefs) return [];
  return columnDefs.flatMap((column) => ('field' in column && column.field ? [String(column.field)] : []));
}
