// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { AgGridReactProps } from 'ag-grid-react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CsvRow } from '@csv-viewer/workspace/csv-viewer';
import { CsvTab } from './csv-tab';
import { workingCsvFixture } from '../test-helpers/csv-views';
import { createTestCsvViewer, withCsvViewer } from '../test-helpers/csv-viewer';
import { CsvGrid } from './csv-grid';

const DataGrid = () => null;

/** Stands in for AG Grid: one header per column and one body cell, in AG Grid's DOM shape. */
function HeaderGrid({ columnDefs }: AgGridReactProps<CsvRow>) {
  const names = (columnDefs ?? []).flatMap((column) => ('field' in column && column.field ? [String(column.field)] : []));
  return (
    <div>
      {names.map((name) => (
        <div key={name} className="ag-header-cell" role="columnheader" col-id={name} tabIndex={-1}>
          <span className="ag-header-cell-text">{name}</span>
        </div>
      ))}
      <div className="ag-cell" role="gridcell" col-id={names[0]}>
        cell
      </div>
    </div>
  );
}

const twoColumns = [
  { name: 'id', type: 'VARCHAR' },
  { name: 'email', type: 'VARCHAR' },
];

const columnPatch = {
  workingCsvId: 'working-csv-1',
  columns: twoColumns,
  hasUnexportedChanges: true,
  canUndo: true,
  canRedo: false,
};

afterEach(cleanup);

describe('CsvColumnMenu', () => {
  it('opens on a header right-click and runs insert and delete on that column', async () => {
    const insertColumn = vi.fn(async () => columnPatch);
    const deleteColumn = vi.fn(async () => ({ ...columnPatch, columns: [twoColumns[0]] }));
    const tab = new CsvTab(
      createTestCsvViewer({ handlers: { 'csv.insert-column': insertColumn, 'csv.delete-column': deleteColumn } }),
      workingCsvFixture({ columns: twoColumns }),
    );
    tab.setFocusedColumn('id');
    render(withCsvViewer(<CsvGrid tab={tab} active DataGrid={HeaderGrid} />));

    const opened = await openMenu('email');
    expect(opened.defaultPrevented).toBe(true);
    expect(tab.snapshot().focusedColumn).toBe('email');
    await act(async () => menuItem('Insert column left').click());
    expect(insertColumn).toHaveBeenCalledWith({
      operation: 'csv.insert-column',
      workingCsvId: 'working-csv-1',
      column: 'email',
      placement: 'before',
    });

    await openMenu('email');
    await act(async () => menuItem('Delete column').click());
    expect(deleteColumn).toHaveBeenCalledWith({
      operation: 'csv.delete-column',
      workingCsvId: 'working-csv-1',
      column: 'email',
    });
  });

  it('leaves right-clicks outside column headers to the browser', async () => {
    const tab = new CsvTab(createTestCsvViewer(), workingCsvFixture({ columns: twoColumns }));
    render(withCsvViewer(<CsvGrid tab={tab} active DataGrid={HeaderGrid} />));

    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    await act(async () => {
      screen.getByRole('gridcell').dispatchEvent(event);
    });

    expect(event.defaultPrevented).toBe(false);
    expect(screen.queryByRole('menu')).toBeNull();
    expect(tab.snapshot().focusedColumn).toBeNull();
  });

  it('ignores another column mutation while insert is pending', async () => {
    const pending = Promise.withResolvers<typeof columnPatch>();
    const insertColumn = vi.fn(() => pending.promise);
    const deleteColumn = vi.fn();
    const tab = new CsvTab(
      createTestCsvViewer({ handlers: { 'csv.insert-column': insertColumn, 'csv.delete-column': deleteColumn } }),
      workingCsvFixture({ columns: twoColumns }),
    );
    render(withCsvViewer(<CsvGrid tab={tab} active DataGrid={HeaderGrid} />));

    await openMenu('id');
    act(() => menuItem('Insert column left').click());
    await openMenu('id');
    for (const name of ['Rename column', 'Insert column left', 'Insert column right', 'Delete column']) {
      expect(menuItem(name).getAttribute('aria-disabled')).toBe('true');
    }
    act(() => menuItem('Insert column right').click());
    act(() => menuItem('Delete column').click());
    expect(insertColumn).toHaveBeenCalledTimes(1);
    expect(deleteColumn).not.toHaveBeenCalled();

    await act(async () => pending.resolve(columnPatch));
    expect(menuItem('Insert column right').getAttribute('aria-disabled')).toBeNull();
    expect(menuItem('Delete column').getAttribute('aria-disabled')).toBeNull();
  });

  it('disables Delete column when only one column remains', async () => {
    const tab = new CsvTab(createTestCsvViewer(), workingCsvFixture({ columns: [twoColumns[0]] }));
    render(withCsvViewer(<CsvGrid tab={tab} active DataGrid={HeaderGrid} />));

    await openMenu('id');

    expect(menuItem('Insert column left').getAttribute('aria-disabled')).toBeNull();
    expect(menuItem('Delete column').getAttribute('aria-disabled')).toBe('true');
  });

  it('renames from the menu in a Column name field under the header', async () => {
    const renameColumn = vi.fn(async () => ({
      ...columnPatch,
      columns: [twoColumns[0], { name: 'work_email', type: 'VARCHAR' }],
    }));
    const tab = new CsvTab(
      createTestCsvViewer({ handlers: { 'csv.rename-column': renameColumn } }),
      workingCsvFixture({ columns: twoColumns }),
    );
    render(withCsvViewer(<CsvGrid tab={tab} active DataGrid={HeaderGrid} />));

    await openMenu('email');
    await act(async () => menuItem('Rename column').click());
    const input = await screen.findByRole('textbox', { name: 'Column name' });
    expect(columnNameValue()).toBe('email');
    fireEvent.change(input, { target: { value: 'work_email' } });
    await act(async () => fireEvent.submit(input));

    expect(renameColumn).toHaveBeenCalledWith({
      operation: 'csv.rename-column',
      workingCsvId: 'working-csv-1',
      column: 'email',
      name: 'work_email',
    });
    expect(screen.queryByRole('textbox', { name: 'Column name' })).toBeNull();
  });

  it('keeps the Column name field open with the reason when a rename is rejected', async () => {
    const tab = new CsvTab(
      createTestCsvViewer({
        handlers: {
          'csv.rename-column': async () => {
            throw new Error('CSV column name already exists.');
          },
        },
      }),
      workingCsvFixture({ columns: twoColumns }),
    );
    render(withCsvViewer(<CsvGrid tab={tab} active DataGrid={HeaderGrid} />));

    await openMenu('email');
    await act(async () => menuItem('Rename column').click());
    const input = await screen.findByRole('textbox', { name: 'Column name' });
    fireEvent.change(input, { target: { value: 'id' } });
    await act(async () => fireEvent.submit(input));

    expect(input.getAttribute('aria-invalid')).toBe('true');
    const reason = document.getElementById(input.getAttribute('aria-describedby') ?? '');
    expect(reason?.textContent).toBe('CSV column name already exists.');
  });

  it('starts rename when F2 is pressed on a column header', async () => {
    const tab = new CsvTab(createTestCsvViewer(), workingCsvFixture({ columns: twoColumns }));
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

  it('closes rename when focus leaves its column and does not reopen on return', async () => {
    const tab = new CsvTab(createTestCsvViewer(), workingCsvFixture({ columns: twoColumns }));
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
  });

  it('does not start rename when F2 is pressed away from a column header', async () => {
    const tab = new CsvTab(createTestCsvViewer(), workingCsvFixture({ columns: twoColumns }));
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
});

async function openMenu(column: string): Promise<MouseEvent> {
  const header = screen.getAllByRole('columnheader').find((element) => element.getAttribute('col-id') === column);
  if (!header) throw new Error(`missing ${column} header`);
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 40, clientY: 10 });
  await act(async () => {
    header.dispatchEvent(event);
  });
  return event;
}

function menuItem(name: string): HTMLElement {
  return screen.getByRole('menuitem', { name });
}

/** A header outside any grid, for the window-level F2 listener. */
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
