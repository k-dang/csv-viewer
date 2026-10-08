import { describe, expect, it, vi } from 'vitest';
import type { CsvCellEditResult, CsvColumnValueCounts, CsvEditState, CsvRowWindow } from '@csv-viewer/workspace/csv-viewer';
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
  totalRowCount: workingCsv.rowCount,
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
  let reject: (cause: Error) => void = () => undefined;
  const promise = new Promise<T>((settle, fail) => {
    resolve = settle;
    reject = fail;
  });
  return { promise, resolve, reject };
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

  it('preserves current row failures and drops rejected requests after query changes or disposal', async () => {
    const failure = new Error('Unable to read the CSV.');
    const superseded = deferred<CsvRowWindow>();
    const disposed = deferred<CsvRowWindow>();
    const getRows = vi.fn()
      .mockRejectedValueOnce(failure)
      .mockReturnValueOnce(superseded.promise)
      .mockReturnValueOnce(disposed.promise);
    const tab = new CsvTab(createTestCsvViewer({ handlers: { 'csv.get-rows': getRows } }), workingCsv);

    await expect(tab.rows(0, 100)).rejects.toBe(failure);
    expect(tab.snapshot().queryStatus).toBe('failed');

    const previousQuery = tab.rows(0, 100);
    tab.setSearch('ada');
    superseded.reject(failure);
    await expect(previousQuery).resolves.toBeNull();
    expect(tab.snapshot().queryStatus).toBe('querying');

    const previousTab = tab.rows(0, 100);
    tab.dispose();
    const state = tab.snapshot();
    disposed.reject(failure);
    await expect(previousTab).resolves.toBeNull();
    expect(tab.snapshot()).toBe(state);
  });

  it('keeps the latest Live Stats when superseded requests finish or reject', async () => {
    const first = deferred<CsvColumnValueCounts>();
    const second = deferred<CsvColumnValueCounts>();
    const latest = deferred<CsvColumnValueCounts>();
    const getCounts = vi.fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockReturnValueOnce(latest.promise);
    const tab = new CsvTab(createTestCsvViewer({ handlers: { 'csv.get-column-value-counts': getCounts } }), workingCsv);

    tab.toggleStats();
    tab.setSearch('ada');
    tab.setSearch('grace');
    latest.resolve(counts(1));
    await vi.waitFor(() => expect(tab.snapshot().stats.result).toEqual({ status: 'ready', counts: counts(1) }));
    const state = tab.snapshot();

    first.resolve(counts(250));
    second.reject(new Error('Superseded stats failed.'));
    await Promise.allSettled([first.promise, second.promise]);
    expect(tab.snapshot()).toBe(state);
  });

  it('ends the stats continuation on panel close, Reopen CSV, and disposal', async () => {
    const closed = deferred<CsvColumnValueCounts>();
    const reopened = deferred<CsvColumnValueCounts>();
    const disposed = deferred<CsvColumnValueCounts>();
    const getCounts = vi.fn()
      .mockReturnValueOnce(closed.promise)
      .mockReturnValueOnce(reopened.promise)
      .mockReturnValueOnce(disposed.promise);
    const tab = new CsvTab(createTestCsvViewer({ handlers: { 'csv.get-column-value-counts': getCounts } }), workingCsv);
    const listener = vi.fn();
    tab.subscribe(listener);

    tab.toggleStats();
    tab.toggleStats();
    let state = tab.snapshot();
    closed.resolve(counts(250));
    await closed.promise;
    expect(tab.snapshot()).toBe(state);

    tab.toggleStats();
    tab.replaceWorkingCsv(workingCsvFixture({ dataRevision: 1, rowCount: 3 }));
    state = tab.snapshot();
    reopened.reject(new Error('Previous CSV stats failed.'));
    await Promise.allSettled([reopened.promise]);
    expect(tab.snapshot()).toBe(state);

    tab.toggleStats();
    tab.dispose();
    listener.mockClear();
    state = tab.snapshot();
    disposed.resolve(counts(3));
    await disposed.promise;
    expect(tab.snapshot()).toBe(state);
    expect(listener).not.toHaveBeenCalled();
  });

  it('shows a current stats failure and permits another refresh', async () => {
    const getCounts = vi.fn()
      .mockRejectedValueOnce(new Error('Counts unavailable.'))
      .mockResolvedValueOnce(counts(250));
    const tab = new CsvTab(createTestCsvViewer({ handlers: { 'csv.get-column-value-counts': getCounts } }), workingCsv);

    tab.toggleStats();
    await vi.waitFor(() => expect(tab.snapshot().stats.result).toEqual({ status: 'failed', message: 'Counts unavailable.' }));
    tab.setStatsColumn('age');
    await vi.waitFor(() => expect(tab.snapshot().stats.result).toEqual({ status: 'ready', counts: counts(250) }));
  });

  it('preserves an admitted mutation outcome after disposal without updating the tab', async () => {
    const edit = deferred<CsvCellEditResult>();
    const tab = new CsvTab(createTestCsvViewer({ handlers: { 'csv.edit-cell': () => edit.promise } }), workingCsv);
    const completion = tab.editCell('row-9', 'name', 'Ada');
    tab.dispose();
    const state = tab.snapshot();

    edit.resolve({ ...editedState, rowId: 'row-9', column: 'name' });
    await expect(completion).resolves.toBe(true);
    expect(tab.snapshot()).toBe(state);
  });

  it('does not admit row, edit, clipboard, or export work after disposal', async () => {
    const viewer = createTestCsvViewer();
    const call = vi.spyOn(viewer, 'call');
    const tab = new CsvTab(viewer, workingCsv);
    tab.setFocusedColumn('name');
    tab.dispose();
    const state = tab.snapshot();

    await expect(tab.rows(0, 100)).resolves.toBeNull();
    await expect(tab.editCell('row-9', 'name', 'Ada')).resolves.toBe(false);
    await expect(tab.copyFocusedColumn()).resolves.toBeUndefined();
    await tab.export();
    await tab.exportView();

    expect(call).not.toHaveBeenCalled();
    expect(tab.snapshot()).toBe(state);
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

  it('shares export admission and releases it after a failure so another export can run', async () => {
    const pending = deferred<{ status: 'exported'; editState: CsvEditState }>();
    const exportCsv = vi.fn().mockReturnValueOnce(pending.promise);
    const exportView = vi.fn(async () => ({ status: 'exported' as const, rowCount: 12 }));
    const tab = new CsvTab(createTestCsvViewer({ handlers: { 'csv.export': exportCsv, 'csv.export-view': exportView } }), workingCsv);
    const completion = tab.export();
    expect(tab.snapshot().exporting).toBe(true);

    await tab.exportView();
    expect(exportView).not.toHaveBeenCalled();
    pending.reject(new Error('Export destination unavailable.'));
    await completion;
    expect(tab.snapshot().exporting).toBe(false);
    expect(tab.snapshot().editError).toBe('Export destination unavailable.');

    await tab.exportView();
    expect(exportView).toHaveBeenCalledOnce();
    expect(tab.snapshot().exporting).toBe(false);
    expect(tab.snapshot().exportConfirmation).toBe('Export complete · 12 rows');
    expect(tab.snapshot().revision).toBe(0);
    expect(tab.snapshot().editState).toEqual(workingCsv.editState);
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

  it('does not write to the clipboard when the tab closes while values are loading', async () => {
    const values = deferred<{ workingCsvId: string; column: string; values: string[] }>();
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    try {
      const tab = new CsvTab(createTestCsvViewer({ handlers: { 'csv.get-column-values': () => values.promise } }), workingCsv);
      tab.setFocusedColumn('name');
      const completion = tab.copyFocusedColumn();
      tab.dispose();

      values.resolve({ workingCsvId: workingCsv.workingCsvId, column: 'name', values: ['Ada'] });
      await expect(completion).resolves.toBeUndefined();
      expect(writeText).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('renames the focused column and remaps query, stats, and focus to the new name', async () => {
    const columns = [
      { name: 'full_name', type: 'VARCHAR' },
      { name: 'age', type: 'BIGINT' },
    ];
    const renameColumn = vi.fn(async () => ({
      ...editedState,
      columns,
    }));
    const getCounts = vi.fn(async () => ({
      workingCsvId: workingCsv.workingCsvId,
      column: 'full_name',
      scopeRowCount: 250,
      values: [],
    }));
    const tab = new CsvTab(
      createTestCsvViewer({ handlers: { 'csv.rename-column': renameColumn, 'csv.get-column-value-counts': getCounts } }),
      workingCsv,
    );
    tab.setFocusedColumn('name');
    tab.setGridQuery([{ column: 'name', direction: 'asc' }], [{ column: 'name', kind: 'text', operator: 'contains', value: 'a' }]);
    tab.toggleStats();
    const revision = tab.snapshot().revision;

    await expect(tab.renameFocusedColumn('full_name')).resolves.toBe(true);

    expect(renameColumn).toHaveBeenCalledWith({
      operation: 'csv.rename-column',
      workingCsvId: workingCsv.workingCsvId,
      column: 'name',
      name: 'full_name',
    });
    const state = tab.snapshot();
    expect(state.workingCsv.columns).toEqual(columns);
    expect(state.focusedColumn).toBe('full_name');
    expect(state.query.sort).toEqual([{ column: 'full_name', direction: 'asc' }]);
    expect(state.query.filters).toEqual([{ column: 'full_name', kind: 'text', operator: 'contains', value: 'a' }]);
    expect(state.stats.column).toBe('full_name');
    expect(state.editState).toEqual(editedState);
    expect(state.revision).toBe(revision + 1);
    await vi.waitFor(() =>
      expect(tab.snapshot().stats.result).toEqual({
        status: 'ready',
        counts: {
          workingCsvId: workingCsv.workingCsvId,
          column: 'full_name',
          scopeRowCount: 250,
          values: [],
        },
      }),
    );
  });

  it('reports a rejected rename and keeps the previous columns', async () => {
    const tab = new CsvTab(
      createTestCsvViewer({
        handlers: {
          'csv.rename-column': async () => {
            throw new Error('CSV column name already exists.');
          },
        },
      }),
      workingCsv,
    );
    tab.setFocusedColumn('name');

    await expect(tab.renameFocusedColumn('age')).resolves.toBe(false);

    const state = tab.snapshot();
    expect(state.editError).toBe('CSV column name already exists.');
    expect(state.workingCsv.columns).toEqual(workingCsv.columns);
    expect(state.focusedColumn).toBe('name');
    expect(state.revision).toBe(0);
  });

  it('does not mutate when the focused column keeps its name', async () => {
    const renameColumn = vi.fn();
    const tab = new CsvTab(createTestCsvViewer({ handlers: { 'csv.rename-column': renameColumn } }), workingCsv);
    tab.setFocusedColumn('name');
    tab.setSelection(['row-1']);
    const revision = tab.snapshot().revision;

    await expect(tab.renameFocusedColumn('name')).resolves.toBe(true);
    await expect(tab.renameFocusedColumn('  name  ')).resolves.toBe(true);

    expect(renameColumn).not.toHaveBeenCalled();
    expect(tab.snapshot().revision).toBe(revision);
    expect(tab.snapshot().selectedRowIds).toEqual(['row-1']);
  });

  it('does not rename when no column is focused', async () => {
    const renameColumn = vi.fn();
    const tab = new CsvTab(createTestCsvViewer({ handlers: { 'csv.rename-column': renameColumn } }), workingCsv);

    await expect(tab.renameFocusedColumn('sku')).resolves.toBe(false);
    expect(renameColumn).not.toHaveBeenCalled();
  });

  it('does not insert or delete a column when none is focused', async () => {
    const insertColumn = vi.fn();
    const deleteColumn = vi.fn();
    const tab = new CsvTab(
      createTestCsvViewer({ handlers: { 'csv.insert-column': insertColumn, 'csv.delete-column': deleteColumn } }),
      workingCsv,
    );

    await expect(tab.insertColumn('before')).resolves.toBe(false);
    await expect(tab.deleteFocusedColumn()).resolves.toBe(false);

    expect(insertColumn).not.toHaveBeenCalled();
    expect(deleteColumn).not.toHaveBeenCalled();
    expect(tab.snapshot().editError).toBeNull();
  });

  it('inserts beside the focused column and keeps focus, query, and data revision', async () => {
    const csv = workingCsvFixture({
      dataRevision: 4,
      columns: [
        { name: 'name', type: 'VARCHAR' },
        { name: 'age', type: 'BIGINT' },
      ],
      rowCount: 250,
    });
    const columns = [
      { name: 'New column', type: 'VARCHAR' },
      { name: 'name', type: 'VARCHAR' },
      { name: 'age', type: 'BIGINT' },
    ];
    const insertColumn = vi.fn(async () => ({
      ...editedState,
      workingCsvId: csv.workingCsvId,
      columns,
    }));
    const tab = new CsvTab(createTestCsvViewer({ handlers: { 'csv.insert-column': insertColumn } }), csv);
    tab.setFocusedColumn('name');
    tab.setSearch('ada');
    tab.setGridQuery(
      [{ column: 'name', direction: 'asc' }],
      [{ column: 'name', kind: 'text', operator: 'contains', value: 'a' }],
    );
    tab.setSelection(['row-1']);

    await expect(tab.insertColumn('before')).resolves.toBe(true);

    expect(insertColumn).toHaveBeenCalledWith({
      operation: 'csv.insert-column',
      workingCsvId: csv.workingCsvId,
      column: 'name',
      placement: 'before',
    });
    const state = tab.snapshot();
    expect(state.workingCsv.columns).toEqual(columns);
    expect(state.workingCsv.dataRevision).toBe(4);
    expect(state.focusedColumn).toBe('name');
    expect(state.query.sort).toEqual([{ column: 'name', direction: 'asc' }]);
    expect(state.query.filters).toEqual([{ column: 'name', kind: 'text', operator: 'contains', value: 'a' }]);
    expect(state.query.search).toBe('ada');
    expect(state.selectedRowIds).toEqual([]);
    expect(state.revision).toBe(1);
  });

  it('deletes the focused column and drops sort, filters, focus, and stats on that name', async () => {
    const columns = [{ name: 'name', type: 'VARCHAR' }];
    const deleteColumn = vi.fn(async () => ({
      ...editedState,
      columns,
    }));
    const getCounts = vi.fn(async () => counts(250));
    const tab = new CsvTab(
      createTestCsvViewer({
        handlers: { 'csv.delete-column': deleteColumn, 'csv.get-column-value-counts': getCounts },
      }),
      workingCsv,
    );
    tab.setFocusedColumn('age');
    tab.setSearch('ada');
    tab.setGridQuery(
      [{ column: 'age', direction: 'desc' }],
      [{ column: 'age', kind: 'text', operator: 'contains', value: '3' }],
    );
    tab.toggleStats();

    await expect(tab.deleteFocusedColumn()).resolves.toBe(true);

    expect(deleteColumn).toHaveBeenCalledWith({
      operation: 'csv.delete-column',
      workingCsvId: workingCsv.workingCsvId,
      column: 'age',
    });
    const state = tab.snapshot();
    expect(state.workingCsv.columns).toEqual(columns);
    expect(state.focusedColumn).toBeNull();
    expect(state.query.sort).toEqual([]);
    expect(state.query.filters).toEqual([]);
    expect(state.query.search).toBe('ada');
    expect(state.stats.column).toBe('name');
    expect(state.revision).toBe(1);
  });

  it('keeps focus and descriptors when the delete result removes a different column', async () => {
    const columns = [{ name: 'name', type: 'VARCHAR' }];
    const deleteColumn = vi.fn(async () => ({
      ...editedState,
      columns,
    }));
    const tab = new CsvTab(createTestCsvViewer({ handlers: { 'csv.delete-column': deleteColumn } }), workingCsv);
    tab.setFocusedColumn('name');
    tab.setGridQuery(
      [{ column: 'name', direction: 'asc' }],
      [{ column: 'name', kind: 'text', operator: 'contains', value: 'a' }],
    );

    await expect(tab.deleteFocusedColumn()).resolves.toBe(true);

    expect(deleteColumn).toHaveBeenCalledWith({
      operation: 'csv.delete-column',
      workingCsvId: workingCsv.workingCsvId,
      column: 'name',
    });
    const state = tab.snapshot();
    expect(state.workingCsv.columns).toEqual(columns);
    expect(state.focusedColumn).toBe('name');
    expect(state.query.sort).toEqual([{ column: 'name', direction: 'asc' }]);
    expect(state.query.filters).toEqual([{ column: 'name', kind: 'text', operator: 'contains', value: 'a' }]);
  });

  it('leaves focus empty and the dropped sort dropped when undo only adds the deleted column back', async () => {
    const withoutName = [{ name: 'age', type: 'BIGINT' }];
    const withName = [
      { name: 'name', type: 'VARCHAR' },
      { name: 'age', type: 'BIGINT' },
    ];
    const tab = new CsvTab(
      createTestCsvViewer({
        handlers: {
          'csv.delete-column': async () => ({ ...editedState, columns: withoutName }),
          'csv.undo': async () => ({ ...editedState, canRedo: true, columns: withName }),
        },
      }),
      workingCsv,
    );
    tab.setFocusedColumn('name');
    tab.setGridQuery(
      [{ column: 'name', direction: 'asc' }],
      [{ column: 'name', kind: 'text', operator: 'contains', value: 'a' }],
    );

    await tab.deleteFocusedColumn();
    expect(tab.snapshot().focusedColumn).toBeNull();
    expect(tab.snapshot().query.sort).toEqual([]);

    await tab.undo();

    const state = tab.snapshot();
    expect(state.workingCsv.columns).toEqual(withName);
    expect(state.focusedColumn).toBeNull();
    expect(state.query.sort).toEqual([]);
    expect(state.query.filters).toEqual([]);
  });

  it('reports a rejected delete and keeps columns, focus, and revision', async () => {
    const tab = new CsvTab(
      createTestCsvViewer({
        handlers: {
          'csv.delete-column': async () => {
            throw new Error('The last CSV column cannot be deleted.');
          },
        },
      }),
      workingCsv,
    );
    tab.setFocusedColumn('name');

    await expect(tab.deleteFocusedColumn()).resolves.toBe(false);

    const state = tab.snapshot();
    expect(state.editError).toBe('The last CSV column cannot be deleted.');
    expect(state.workingCsv.columns).toEqual(workingCsv.columns);
    expect(state.focusedColumn).toBe('name');
    expect(state.revision).toBe(0);
  });
});
