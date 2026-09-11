import { describe, expect, it, vi } from 'vitest';
import type { ComparisonRow, ComparisonWindowOutcome } from '@csv-viewer/workspace/csv-viewer';
import { comparisonGridRequestBounds, createComparisonGridDataSource } from './comparison-grid-data-source';

const row: ComparisonRow = {
  classification: 'unchanged',
  keyValues: ['1'],
  baseline: { rowId: 'b1', values: ['same'] },
  candidate: { rowId: 'c1', values: ['same'] },
  changed: [false],
};

function ready(resultToken: string): ComparisonWindowOutcome {
  return {
    status: 'ready',
    window: {
      comparisonId: 'comparison-1',
      resultToken,
      offset: 25,
      totalRowCount: 1,
      keyColumns: ['id'],
      valueColumns: [{ name: 'value', changedRowCount: 0 }],
      rows: [row],
    },
  };
}

describe('createComparisonGridDataSource', () => {
  it('enforces the grid cache and request bounds from the verification contract', async () => {
    const getComparisonWindow = vi.fn().mockResolvedValue(ready('result-1'));
    const successCallback = vi.fn();
    const failCallback = vi.fn();
    const dataSource = createComparisonGridDataSource(
      { call: getComparisonWindow },
      {
        comparisonId: 'comparison-1',
        resultToken: 'result-1',
        rows: 'differences',
        columns: 'changed-first',
      },
      (value) => value,
    );

    // SAFETY: The datasource reads only the row bounds and callbacks supplied by this fixture.
    dataSource.getRows({
      startRow: 25,
      endRow: 2_025,
      successCallback,
      failCallback,
    } as never);

    await vi.waitFor(() => expect(successCallback).toHaveBeenCalledWith([row], 1));
    expect(getComparisonWindow).toHaveBeenCalledWith({
      operation: 'comparison.get-window',
      comparisonId: 'comparison-1',
      resultToken: 'result-1',
      offset: 25,
      limit: 1_000,
      rows: 'differences',
      columns: 'changed-first',
    });
    expect(failCallback).not.toHaveBeenCalled();
    expect(comparisonGridRequestBounds).toEqual({
      cacheBlockSize: 100,
      maxBlocksInCache: 6,
      maxConcurrentRequests: 2,
      maxWindowRows: 1_000,
    });
  });

  it.each(['resolve', 'reject'] as const)('ignores a retired request that later %ss and allows datasource reuse', async (completion) => {
    const pending = Promise.withResolvers<ComparisonWindowOutcome>();
    const getComparisonWindow = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(ready('result-1'));
    const successCallback = vi.fn();
    const failCallback = vi.fn();
    const dataSource = createComparisonGridDataSource(
      { call: getComparisonWindow },
      {
        comparisonId: 'comparison-1',
        resultToken: 'result-1',
        rows: 'all',
        columns: 'csv-order',
      },
      (value) => value,
    );

    // SAFETY: The datasource reads only the row bounds and callbacks supplied by this fixture.
    dataSource.getRows({
      startRow: 0,
      endRow: 100,
      successCallback,
      failCallback,
    } as never);
    dataSource.destroy?.();
    if (completion === 'resolve') pending.resolve(ready('result-1'));
    else pending.reject(new Error('Retired request failed.'));
    await pending.promise.catch(() => undefined);
    await Promise.resolve();

    expect(failCallback).not.toHaveBeenCalled();
    expect(successCallback).not.toHaveBeenCalled();

    // SAFETY: The datasource reads only the row bounds and callbacks supplied by this fixture.
    dataSource.getRows({ startRow: 0, endRow: 100, successCallback, failCallback } as never);
    await vi.waitFor(() => expect(successCallback).toHaveBeenCalledWith([row], 1));
  });

  it('rejects a response for a different result token', async () => {
    const successCallback = vi.fn();
    const failCallback = vi.fn();
    const dataSource = createComparisonGridDataSource(
      { call: vi.fn().mockResolvedValue(ready('result-2')) },
      { comparisonId: 'comparison-1', resultToken: 'result-1', rows: 'all', columns: 'csv-order' },
      (value) => value,
    );
    // SAFETY: The datasource reads only the row bounds and callbacks supplied by this fixture.
    dataSource.getRows({ startRow: 0, endRow: 100, successCallback, failCallback } as never);
    await vi.waitFor(() => expect(failCallback).toHaveBeenCalledOnce());
    expect(successCallback).not.toHaveBeenCalled();
  });
});
