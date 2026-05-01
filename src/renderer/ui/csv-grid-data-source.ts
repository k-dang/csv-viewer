import type { IDatasource, IGetRowsParams } from 'ag-grid-community';
import type { CsvSessionMetadata, CsvViewerApi } from '../../shared/ipc';

export function createCsvGridDataSource(
  session: CsvSessionMetadata,
  api: Pick<CsvViewerApi, 'getCsvRows'>,
): IDatasource {
  return {
    rowCount: session.rowCount,
    getRows: (params: IGetRowsParams) => {
      const offset = params.startRow;
      const limit = Math.max(0, params.endRow - params.startRow);

      api
        .getCsvRows({ sessionId: session.sessionId, offset, limit })
        .then((window) => {
          params.successCallback(window.rows, session.rowCount);
        })
        .catch(() => {
          params.failCallback();
        });
    },
  };
}
