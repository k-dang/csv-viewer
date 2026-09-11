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
      () => 'result-1',
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

  it('ignores a response whose result token became obsolete while the request was active', async () => {
    let resolveWindow: (outcome: ComparisonWindowOutcome) => void = () => undefined;
    const getComparisonWindow = vi.fn().mockReturnValue(
      new Promise<ComparisonWindowOutcome>((resolve) => {
        resolveWindow = resolve;
      }),
    );
    let activeResultToken = 'result-1';
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
      () => activeResultToken,
      (value) => value,
    );

    // SAFETY: The datasource reads only the row bounds and callbacks supplied by this fixture.
    dataSource.getRows({
      startRow: 0,
      endRow: 100,
      successCallback,
      failCallback,
    } as never);
    activeResultToken = 'result-2';
    resolveWindow(ready('result-1'));

    await vi.waitFor(() => expect(failCallback).toHaveBeenCalledOnce());
    expect(successCallback).not.toHaveBeenCalled();
  });
});
