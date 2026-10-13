import { Rpc, RpcGroup } from 'effect/rpc';
import { Schema } from 'effect';
import { DataEngineError } from './database';
import { CsvOpenError, WorkspaceRequestError } from './errors';
import {
  BeginComparisonRequest,
  CancelComparisonRequest,
  CloseWorkingCsvRequest,
  ComparisonWindowRequest,
  CsvCellEditRequest,
  CsvColumnValueCountsRequest,
  CsvColumnValuesRequest,
  CsvDeleteColumnRequest,
  CsvDeleteRowsRequest,
  CsvDialectOptions,
  CsvEditStateRequest,
  CsvExportRequest,
  CsvInsertColumnRequest,
  CsvInsertRowRequest,
  CsvRenameColumnRequest,
  CsvReorderColumnsRequest,
  CsvRowWindowRequest,
  CsvViewExportRequest,
  OpenComparisonRequest,
} from './csv-viewer-requests';
import {
  BeginComparisonResult,
  CancelComparisonResult,
  CloseComparisonResult,
  CloseWorkingCsvOutcome,
  ComparisonCandidate,
  ComparisonMutationOutcome,
  ComparisonWindowOutcome,
  CsvCellEditResult,
  CsvColumnValueCounts,
  CsvColumnValues,
  CsvEditStateResult,
  CsvExportOutcome,
  CsvRowWindow,
  CsvSchemaEditStateResult,
  CsvViewerEvent,
  CsvViewExportOutcome,
  OpenComparisonResult,
  OpenCsvResult,
  RecentCsvSource,
} from './csv-viewer-results';
import { CsvSourceUnavailableError } from './workspace-host';

/** Every failure a renderer is allowed to see. Anything else stays a sanitized defect. */
export const CsvViewerRpcError = Schema.Union([
  WorkspaceRequestError,
  CsvOpenError,
  DataEngineError,
  CsvSourceUnavailableError,
]);

const OpenCsvPayload = Schema.Struct({
  sourceId: Schema.optional(Schema.String),
  options: Schema.optional(CsvDialectOptions),
});

const OpenRecentPayload = Schema.Struct({
  sourceId: Schema.String,
  options: Schema.optional(CsvDialectOptions),
});

const ReopenPayload = Schema.Struct({
  workingCsvId: Schema.String,
  options: Schema.optional(CsvDialectOptions),
});

const request = <const Tag extends string, Payload extends Schema.Top, Success extends Schema.Top>(
  tag: Tag,
  payload: Payload,
  success: Success,
) => Rpc.make(tag, { payload, success, error: CsvViewerRpcError });

export const CsvOpen = request('csv.open', OpenCsvPayload, OpenCsvResult);
export const CsvOpenRecent = request('csv.open-recent', OpenRecentPayload, OpenCsvResult);
export const CsvReopen = request('csv.reopen', ReopenPayload, OpenCsvResult);
export const CsvGetRecentSources = request('csv.get-recent-sources', Schema.Struct({}), Schema.Array(RecentCsvSource));
export const CsvGetRows = request('csv.get-rows', CsvRowWindowRequest, CsvRowWindow);
export const CsvGetColumnValues = request('csv.get-column-values', CsvColumnValuesRequest, CsvColumnValues);
export const CsvGetColumnValueCounts = request('csv.get-column-value-counts', CsvColumnValueCountsRequest, CsvColumnValueCounts);
export const CsvEditCell = request('csv.edit-cell', CsvCellEditRequest, CsvCellEditResult);
export const CsvDeleteRows = request('csv.delete-rows', CsvDeleteRowsRequest, CsvEditStateResult);
export const CsvInsertRow = request('csv.insert-row', CsvInsertRowRequest, CsvEditStateResult);
export const CsvRenameColumn = request('csv.rename-column', CsvRenameColumnRequest, CsvSchemaEditStateResult);
export const CsvInsertColumn = request('csv.insert-column', CsvInsertColumnRequest, CsvSchemaEditStateResult);
export const CsvDeleteColumn = request('csv.delete-column', CsvDeleteColumnRequest, CsvSchemaEditStateResult);
export const CsvReorderColumns = request('csv.reorder-columns', CsvReorderColumnsRequest, CsvSchemaEditStateResult);
export const CsvGetEditState = request('csv.get-edit-state', CsvEditStateRequest, CsvEditStateResult);
export const CsvUndo = request('csv.undo', CsvEditStateRequest, CsvSchemaEditStateResult);
export const CsvRedo = request('csv.redo', CsvEditStateRequest, CsvSchemaEditStateResult);
export const CsvExport = request('csv.export', CsvExportRequest, CsvExportOutcome);
export const CsvExportView = request('csv.export-view', CsvViewExportRequest, CsvViewExportOutcome);
export const CsvClose = request('csv.close', CloseWorkingCsvRequest, CloseWorkingCsvOutcome);
export const ComparisonGetCandidates = request('comparison.get-candidates', Schema.Struct({ baselineId: Schema.String }), Schema.Array(ComparisonCandidate));
export const ComparisonOpen = request('comparison.open', OpenComparisonRequest, OpenComparisonResult);
export const ComparisonBegin = request('comparison.begin', BeginComparisonRequest, BeginComparisonResult);
export const ComparisonCancel = request('comparison.cancel', CancelComparisonRequest, CancelComparisonResult);
export const ComparisonGetWindow = request('comparison.get-window', ComparisonWindowRequest, ComparisonWindowOutcome);
export const ComparisonSwap = request('comparison.swap', Schema.Struct({ comparisonId: Schema.String }), ComparisonMutationOutcome);
export const ComparisonClose = request('comparison.close', Schema.Struct({ comparisonId: Schema.String }), CloseComparisonResult);

/** Records a payload the request union rejected, without accepting any of its fields. */
export const CsvViewerMalformed = Rpc.make('csvViewer.malformed', {
  payload: Schema.Struct({}),
  success: Schema.Void,
  error: WorkspaceRequestError,
});

/** Desktop drop acquisition. Web keeps browser `File` registration in the page. */
export const CsvAcquireDroppedSource = Rpc.make('csv.acquire-dropped-source', {
  payload: Schema.Struct({ path: Schema.String }),
  success: Schema.String,
  error: Schema.Union([WorkspaceRequestError, CsvSourceUnavailableError]),
});

/** Comparison progress, menu intents, and the fatal engine stop. */
export const WorkspaceEvents = Rpc.make('workspace.events', {
  payload: Schema.Struct({}),
  success: CsvViewerEvent,
  error: Schema.Never,
  stream: true,
});

export const CsvViewerRpcs = RpcGroup.make(
  CsvOpen,
  CsvOpenRecent,
  CsvReopen,
  CsvGetRecentSources,
  CsvGetRows,
  CsvGetColumnValues,
  CsvGetColumnValueCounts,
  CsvEditCell,
  CsvDeleteRows,
  CsvInsertRow,
  CsvRenameColumn,
  CsvInsertColumn,
  CsvDeleteColumn,
  CsvReorderColumns,
  CsvGetEditState,
  CsvUndo,
  CsvRedo,
  CsvExport,
  CsvExportView,
  CsvClose,
  ComparisonGetCandidates,
  ComparisonOpen,
  ComparisonBegin,
  ComparisonCancel,
  ComparisonGetWindow,
  ComparisonSwap,
  ComparisonClose,
  CsvViewerMalformed,
  CsvAcquireDroppedSource,
  WorkspaceEvents,
);
