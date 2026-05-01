import { describe, expect, it, vi } from 'vitest';
import type { CsvSessionMetadata } from '../../shared/ipc';
import { createCsvGridDataSource } from './csv-grid-data-source';

const session: CsvSessionMetadata = {
  sessionId: 'session-1',
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
};

describe('createCsvGridDataSource', () => {
  it('requests only the AG Grid row window from the preload API', async () => {
    const getCsvRows = vi.fn().mockResolvedValue({
      sessionId: session.sessionId,
      offset: 100,
      filteredRowCount: 250,
      rows: [{ name: 'Ada', age: 37 }],
    });
    const successCallback = vi.fn();
    const failCallback = vi.fn();
    const onFilteredRowCount = vi.fn();

    const datasource = createCsvGridDataSource(session, { getCsvRows }, onFilteredRowCount);
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
      sessionId: session.sessionId,
      offset: 100,
      limit: 25,
      sort: [{ column: 'age', direction: 'desc' }],
      filters: [
        { column: 'name', kind: 'text', operator: 'contains', value: 'Ada' },
        { column: 'age', kind: 'number', operator: 'greaterThan', value: 30, valueTo: undefined },
      ],
    });
    expect(onFilteredRowCount).toHaveBeenCalledWith(250);
    expect(failCallback).not.toHaveBeenCalled();
  });

  it('reports failed row-window requests to AG Grid', async () => {
    const getCsvRows = vi.fn().mockRejectedValue(new Error('query failed'));
    const successCallback = vi.fn();
    const failCallback = vi.fn();

    const datasource = createCsvGridDataSource(session, { getCsvRows });
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
  });
});
