import type { IDatasource } from 'ag-grid-community';
import type {
  ComparisonColumnsMode,
  ComparisonId,
  ComparisonResultToken,
  ComparisonRow,
  ComparisonRowsMode,
  CsvViewerRuntime,
} from '../../shared/csv-viewer-contract';

export const comparisonGridRequestBounds = {
  cacheBlockSize: 100,
  maxBlocksInCache: 6,
  maxConcurrentRequests: 2,
  maxWindowRows: 1_000,
} as const;

type ComparisonGridRequest = {
  comparisonId: ComparisonId;
  resultToken: ComparisonResultToken;
  rows: ComparisonRowsMode;
  columns: ComparisonColumnsMode;
};

export function createComparisonGridDataSource<Row>(
  runtime: Pick<CsvViewerRuntime, 'getComparisonWindow'>,
  request: ComparisonGridRequest,
  getActiveResultToken: () => ComparisonResultToken | null,
  projectRow: (row: ComparisonRow) => Row,
): IDatasource {
  return {
    getRows(params) {
      const offset = params.startRow;
      const limit = Math.min(
        comparisonGridRequestBounds.maxWindowRows,
        Math.max(0, params.endRow - params.startRow),
      );
      void runtime
        .getComparisonWindow({
          comparisonId: request.comparisonId,
          resultToken: request.resultToken,
          offset,
          limit,
          rows: request.rows,
          columns: request.columns,
        })
        .then((outcome) => {
          if (
            outcome.status !== 'ready' ||
            outcome.window.resultToken !== request.resultToken ||
            getActiveResultToken() !== request.resultToken
          ) {
            params.failCallback();
            return;
          }
          params.successCallback(outcome.window.rows.map(projectRow), outcome.window.totalRowCount);
        })
        .catch(() => params.failCallback());
    },
  };
}
