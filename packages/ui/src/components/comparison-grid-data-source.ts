import type { IDatasource } from 'ag-grid-community';
import type {
  ComparisonColumnsMode,
  ComparisonId,
  ComparisonResultToken,
  ComparisonRow,
  ComparisonRowsMode,
  CsvViewer,
} from '@csv-viewer/workspace/csv-viewer';

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
  viewer: Pick<CsvViewer, 'call'>,
  request: ComparisonGridRequest,
  getActiveResultToken: () => ComparisonResultToken | null,
  projectRow: (row: ComparisonRow) => Row,
): IDatasource {
  return {
    getRows(params) {
      const offset = params.startRow;
      const limit = Math.min(comparisonGridRequestBounds.maxWindowRows, Math.max(0, params.endRow - params.startRow));
      void viewer
        .call({
          operation: 'comparison.get-window',
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
