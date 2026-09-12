import { describe, expect, it, vi } from 'vitest';
import type { CsvColumnValueCounts, CsvEditState, CsvRowWindow } from '@csv-viewer/workspace/csv-viewer';
import { CsvTab } from './csv-tab';
import { workingCsvFixture } from '../test-helpers/csv-views';
import { createTestCsvViewer } from '../test-helpers/csv-viewer';

const workingCsv = workingCsvFixture({
  columns: [
    { name: 'name', type: 'VARCHAR' },
    { name: 'age', type: 'BIGINT' },
  ],
  rowCount: 250,
});

const rowWindow = (filteredRowCount: number): CsvRowWindow => ({
  workingCsvId: workingCsv.workingCsvId,
  offset: 0,
  rows: [],
  filteredRowCount,
});

const counts = (scopeRowCount: number): CsvColumnValueCounts => ({
  workingCsvId: workingCsv.workingCsvId,
  column: 'name',
  scopeRowCount,
  values: [],
});

const editedState: CsvEditState = {
  workingCsvId: workingCsv.workingCsvId,
  hasUnexportedChanges: true,
  canUndo: true,
  canRedo: false,
};

/** Lets a test resolve one call while the Tab holds it in flight. */
function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

describe('CsvTab', () => {
  it('serves the row window and the Count Scope from one query', async () => {
    const getRows = vi.fn(async () => rowWindow(12));
    const getCounts = vi.fn(async () => counts(12));
    const tab = new CsvTab(
      createTestCsvViewer({ handlers: { 'csv.get-rows': getRows, 'csv.get-column-value-counts': getCounts } }),
      workingCsv,
    );

    tab.toggleStats();
    tab.setSearch(' ada ');
    tab.setGridQuery([{ column: 'age', direction: 'desc' }], [{ column: 'name', kind: 'text', operator: 'contains', value: 'a' }]);
    await tab.rows(100, 25);

    expect(getRows).toHaveBeenLastCalledWith({
      operation: 'csv.get-rows',
      workingCsvId: workingCsv.workingCsvId,
      offset: 100,
      limit: 25,
      sort: [{ column: 'age', direction: 'desc' }],
      filters: [{ column: 'name', kind: 'text', operator: 'contains', value: 'a' }],
      search: 'ada',
    });
    expect(getCounts).toHaveBeenLastCalledWith({
      operation: 'csv.get-column-value-counts',
      workingCsvId: workingCsv.workingCsvId,
      column: 'name',
      filters: [{ column: 'name', kind: 'text', operator: 'contains', value: 'a' }],
      search: 'ada',
    });
    const state = tab.snapshot();
    expect(state.hasActiveQuery).toBe(true);
    expect(state.filteredRowCount).toBe(12);
    expect(state.totalRowCount).toBe(250);
    expect(state.queryStatus).toBe('ready');
  });

  it('refreshes Live Stats and clears the selection after a mutation', async () => {
    const getCounts = vi.fn(async () => counts(250));
    const deleteRows = vi.fn(async () => editedState);
    const tab = new CsvTab(
      createTestCsvViewer({ handlers: { 'csv.delete-rows': deleteRows, 'csv.get-column-value-counts': getCounts } }),
      workingCsv,
    );
    tab.toggleStats();
    tab.setSelection(['row-1', 'row-2']);
    const revision = tab.snapshot().revision;

    await expect(tab.deleteSelectedRows()).resolves.toBe(true);

    expect(deleteRows).toHaveBeenCalledWith({
      operation: 'csv.delete-rows',
      workingCsvId: workingCsv.workingCsvId,
      rowIds: ['row-1', 'row-2'],
    });
    const state = tab.snapshot();
    expect(state.editState).toEqual(editedState);
    expect(state.selectedRowIds).toEqual([]);
    expect(state.revision).toBe(revision + 1);
    expect(getCounts).toHaveBeenCalledTimes(2);
    await vi.waitFor(() => expect(tab.snapshot().stats.result).toEqual({ status: 'ready', counts: counts(250) }));
  });

  it('drops a row window that a newer query superseded', async () => {
    const first = deferred<CsvRowWindow>();
    const getRows = vi.fn().mockReturnValueOnce(first.promise).mockResolvedValueOnce(rowWindow(1));
    const tab = new CsvTab(createTestCsvViewer({ handlers: { 'csv.get-rows': getRows } }), workingCsv);

    const stale = tab.rows(0, 100);
    tab.setSearch('grace');
    await expect(tab.rows(0, 100)).resolves.toEqual(rowWindow(1));

    first.resolve(rowWindow(250));
    await expect(stale).resolves.toBeNull();
    expect(tab.snapshot().filteredRowCount).toBe(1);
  });

  it('reports a rejected edit and keeps the previous edit state', async () => {
    const tab = new CsvTab(
      createTestCsvViewer({
        handlers: {
          'csv.edit-cell': async () => {
            throw new Error('CSV row no longer exists.');
          },
        },
      }),
      workingCsv,
    );

    await expect(tab.editCell('row-9', 'name', 'Ada')).resolves.toBe(false);

    const state = tab.snapshot();
    expect(state.editError).toBe('CSV row no longer exists.');
    expect(state.editState).toEqual(workingCsv.editState);
    expect(state.revision).toBe(0);
  });

  it('starts the query, selection, and Stats Panel over on Reopen CSV', () => {
    const tab = new CsvTab(
      createTestCsvViewer({ handlers: { 'csv.get-column-value-counts': async () => counts(250) } }),
      workingCsvFixture({ editState: editedState }),
    );
    tab.setSearch('ada');
    tab.setSelection(['row-1']);
    tab.toggleStats();
    const reopened = workingCsvFixture({ dataRevision: 1, rowCount: 3 });

    tab.replaceWorkingCsv(reopened);

    const state = tab.snapshot();
    expect(state.workingCsv).toBe(reopened);
    expect(state.editState).toEqual(reopened.editState);
    expect(state.query).toEqual({ sort: [], filters: [], search: '' });
    expect(state.hasActiveQuery).toBe(false);
    expect(state.selectedRowIds).toEqual([]);
    expect(state.stats.open).toBe(false);
    expect(state.totalRowCount).toBe(3);
    expect(state.revision).toBe(1);
  });

  it('records the exported edit state without refetching rows', async () => {
    const exportedState: CsvEditState = { ...editedState, hasUnexportedChanges: false };
    const tab = new CsvTab(
      createTestCsvViewer({
        handlers: { 'csv.export': async () => ({ status: 'exported', editState: exportedState }) },
      }),
      workingCsvFixture({ editState: editedState }),
    );

    await tab.export();

    const state = tab.snapshot();
    expect(state.editState).toEqual(exportedState);
    expect(state.revision).toBe(0);
  });

  it('copies the focused column under the current query, nulls as empty lines', async () => {
    const getColumnValues = vi.fn(async () => ({
      workingCsvId: workingCsv.workingCsvId,
      column: 'age',
      values: ['30', null, '41'],
    }));
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const tab = new CsvTab(createTestCsvViewer({ handlers: { 'csv.get-column-values': getColumnValues } }), workingCsv);

    expect(await tab.copyFocusedColumn()).toBeUndefined();
    expect(getColumnValues).not.toHaveBeenCalled();

    tab.setFocusedColumn('age');
    tab.setSearch('ada');
    tab.setGridQuery([{ column: 'age', direction: 'desc' }], []);
    expect(await tab.copyFocusedColumn()).toEqual({ column: 'age', count: 3 });

    expect(getColumnValues).toHaveBeenCalledWith({
      operation: 'csv.get-column-values',
      workingCsvId: workingCsv.workingCsvId,
      column: 'age',
      sort: [{ column: 'age', direction: 'desc' }],
      filters: [],
      search: 'ada',
    });
    expect(writeText).toHaveBeenCalledWith('30\n\n41');
    vi.unstubAllGlobals();
  });
});
