import { describe, expect, it, vi } from 'vitest';
import type { WorkingCsvView } from '../../shared/ipc';
import { createCsvGridDataSource } from './csv-grid-data-source';

const session: WorkingCsvView = {
  workingCsvId: 'session-1',
  dataRevision: 0,
  file: {
    path: 'C:\\data\\people.csv',
    name: 'people.csv',
    sizeBytes: 32,
  },
  columns: [
    { name: 'name', type: 'VARCHAR' },
    { name: 'age', type: 'BIGINT' },
  ],
  rowCount: 250,
  dialect: {},
  editState: { workingCsvId: 'session-1', dirty: false, canUndo: false, canRedo: false },
};

describe('createCsvGridDataSource', () => {
  it('requests only the AG Grid row window from the preload API', async () => {
    const getCsvRows = vi.fn().mockResolvedValue({
      workingCsvId: session.workingCsvId,
      offset: 100,
      filteredRowCount: 250,
      rows: [{ name: 'Ada', age: 37 }],
    });
    const successCallback = vi.fn();
    const failCallback = vi.fn();
    const onFilteredRowCount = vi.fn();
    const onQueryState = vi.fn();

    const datasource = createCsvGridDataSource(
      session,
      { getCsvRows },
      onFilteredRowCount,
      'Ada',
      undefined,
      onQueryState,
    );
    datasource.getRows({
      startRow: 100,
      endRow: 125,
      sortModel: [{ colId: 'age', sort: 'desc' }],
      filterModel: {
        name: { filterType: 'text', type: 'contains', filter: 'Ada' },
        age: { filterType: 'number', type: 'greaterThan', filter: 30 },
      },
      successCallback,
      failCallback,
    } as never);

    await vi.waitFor(() => {
      expect(successCallback).toHaveBeenCalledWith([{ name: 'Ada', age: 37 }], 250);
    });

    expect(getCsvRows).toHaveBeenCalledWith({
      workingCsvId: session.workingCsvId,
      offset: 100,
      limit: 25,
      sort: [{ column: 'age', direction: 'desc' }],
      filters: [
        { column: 'name', kind: 'text', operator: 'contains', value: 'Ada' },
        { column: 'age', kind: 'number', operator: 'greaterThan', value: 30, valueTo: undefined },
      ],
      search: 'Ada',
    });
    expect(onFilteredRowCount).toHaveBeenCalledWith(250);
    expect(onQueryState).toHaveBeenNthCalledWith(1, 'querying');
    expect(onQueryState).toHaveBeenNthCalledWith(2, 'ready');
    expect(failCallback).not.toHaveBeenCalled();
  });

  it('reports failed row-window requests to AG Grid', async () => {
    const getCsvRows = vi.fn().mockRejectedValue(new Error('query failed'));
    const successCallback = vi.fn();
    const failCallback = vi.fn();
    const onQueryState = vi.fn();

    const datasource = createCsvGridDataSource(
      session,
      { getCsvRows },
      undefined,
      '',
      undefined,
      onQueryState,
    );
    datasource.getRows({
      startRow: 0,
      endRow: 100,
      sortModel: [],
      filterModel: {},
      successCallback,
      failCallback,
    } as never);

    await vi.waitFor(() => {
      expect(failCallback).toHaveBeenCalledOnce();
    });

    expect(successCallback).not.toHaveBeenCalled();
    expect(onQueryState).toHaveBeenNthCalledWith(1, 'querying');
    expect(onQueryState).toHaveBeenNthCalledWith(2, 'failed');
  });

  it('ignores stale row-window responses when a newer request supersedes them', async () => {
    let resolveFirst: (value: unknown) => void = () => undefined;
    const firstRequest = new Promise((resolve) => {
      resolveFirst = resolve;
    });
    const getCsvRows = vi
      .fn()
      .mockReturnValueOnce(firstRequest)
      .mockResolvedValueOnce({
        workingCsvId: session.workingCsvId,
        offset: 0,
        filteredRowCount: 1,
        rows: [{ name: 'Grace', age: 41 }],
      });
    const firstSuccessCallback = vi.fn();
    const secondSuccessCallback = vi.fn();
    const onFilteredRowCount = vi.fn();
    const requestState = { latestRequestId: 0 };

    const firstDatasource = createCsvGridDataSource(
      session,
      { getCsvRows },
      onFilteredRowCount,
      'Ada',
      requestState,
    );
    const secondDatasource = createCsvGridDataSource(
      session,
      { getCsvRows },
      onFilteredRowCount,
      'Grace',
      requestState,
    );

    firstDatasource.getRows({
      startRow: 0,
      endRow: 100,
      sortModel: [],
      filterModel: {},
      successCallback: firstSuccessCallback,
      failCallback: vi.fn(),
    } as never);
    secondDatasource.getRows({
      startRow: 0,
      endRow: 100,
      sortModel: [],
      filterModel: {},
      successCallback: secondSuccessCallback,
      failCallback: vi.fn(),
    } as never);

    await vi.waitFor(() => {
      expect(secondSuccessCallback).toHaveBeenCalledWith([{ name: 'Grace', age: 41 }], 1);
    });

    resolveFirst({
      workingCsvId: session.workingCsvId,
      offset: 0,
      filteredRowCount: 1,
      rows: [{ name: 'Ada', age: 37 }],
    });

    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(firstSuccessCallback).not.toHaveBeenCalled();
    expect(onFilteredRowCount).toHaveBeenCalledTimes(1);
  });
});
