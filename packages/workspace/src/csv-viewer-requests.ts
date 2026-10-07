import { Schema, Tuple } from 'effect';

/**
 * Runtime definitions of every CsvViewer request. Each request type is derived from the constant of
 * the same name, so a request's type and its validation cannot drift apart. The workspace decodes
 * every request against `CsvViewerRequest` before dispatch. `csv-viewer.ts` re-exports only the
 * types, so the renderer never bundles Effect.
 */

export const CsvDialectOptions = Schema.Struct({
  delimiter: Schema.optional(Schema.String),
  header: Schema.optional(Schema.Boolean),
});
export type CsvDialectOptions = typeof CsvDialectOptions.Type;

export const CsvSortDescriptor = Schema.Struct({
  column: Schema.String,
  direction: Schema.Literals(['asc', 'desc']),
});
export type CsvSortDescriptor = typeof CsvSortDescriptor.Type;

export const CsvNumberFilterOperator = Schema.Literals([
  'equals', 'notEqual', 'greaterThan', 'greaterThanOrEqual', 'lessThan', 'lessThanOrEqual', 'inRange',
]);
export type CsvNumberFilterOperator = typeof CsvNumberFilterOperator.Type;

export const CsvDateFilterOperator = CsvNumberFilterOperator;
export type CsvDateFilterOperator = typeof CsvDateFilterOperator.Type;

export const CsvBlankFilterOperator = Schema.Literals(['blank', 'notBlank']);
export type CsvBlankFilterOperator = typeof CsvBlankFilterOperator.Type;

export const CsvValuesFilterOperator = Schema.Literals(['in', 'notIn']);
export type CsvValuesFilterOperator = typeof CsvValuesFilterOperator.Type;

/**
 * Number filter values accept `NaN`, which the renderer sends for a non-numeric filter entry.
 * A `text` filter matches a case-insensitive substring. A `values` filter keeps (`in`) or hides
 * (`notIn`) exact Counted Values, where `null` and the empty string are distinct values.
 */
export const CsvFilterDescriptor = Schema.Union([
  Schema.Struct({
    column: Schema.String,
    kind: Schema.Literal('text'),
    operator: Schema.Literal('contains'),
    value: Schema.String,
  }),
  Schema.Struct({
    column: Schema.String,
    kind: Schema.Literal('values'),
    operator: CsvValuesFilterOperator,
    values: Schema.Array(Schema.NullOr(Schema.String)),
  }),
  Schema.Struct({
    column: Schema.String,
    kind: Schema.Literal('number'),
    operator: Schema.Union([CsvNumberFilterOperator, CsvBlankFilterOperator]),
    value: Schema.optional(Schema.Number),
    valueTo: Schema.optional(Schema.Number),
  }),
  Schema.Struct({
    column: Schema.String,
    kind: Schema.Literal('date'),
    operator: Schema.Union([CsvDateFilterOperator, CsvBlankFilterOperator]),
    value: Schema.optional(Schema.String),
    valueTo: Schema.optional(Schema.String),
  }),
]);
export type CsvFilterDescriptor = typeof CsvFilterDescriptor.Type;

/** The store checks the maximum `limit`, so its `1000 or less` message stays unchanged. */
export const CsvRowWindowRequest = Schema.Struct({
  workingCsvId: Schema.String,
  offset: Schema.Natural,
  limit: Schema.Natural,
  sort: Schema.optional(Schema.Array(CsvSortDescriptor)),
  filters: Schema.optional(Schema.Array(CsvFilterDescriptor)),
  search: Schema.optional(Schema.String),
});
export type CsvRowWindowRequest = typeof CsvRowWindowRequest.Type;

/** One column under the row window's full query, so the copy matches what the grid shows. */
export const CsvColumnValuesRequest = Schema.Struct({
  workingCsvId: Schema.String,
  column: Schema.String,
  sort: Schema.optional(Schema.Array(CsvSortDescriptor)),
  filters: Schema.optional(Schema.Array(CsvFilterDescriptor)),
  search: Schema.optional(Schema.String),
});
export type CsvColumnValuesRequest = typeof CsvColumnValuesRequest.Type;

export const CsvColumnValueCountsRequest = Schema.Struct({
  workingCsvId: Schema.String,
  column: Schema.String,
  filters: Schema.optional(Schema.Array(CsvFilterDescriptor)),
  search: Schema.optional(Schema.String),
});
export type CsvColumnValueCountsRequest = typeof CsvColumnValueCountsRequest.Type;

export const CsvCellEditRequest = Schema.Struct({
  workingCsvId: Schema.String,
  rowId: Schema.String,
  column: Schema.String,
  value: Schema.String,
});
export type CsvCellEditRequest = typeof CsvCellEditRequest.Type;

export const CsvDeleteRowsRequest = Schema.Struct({
  workingCsvId: Schema.String,
  rowIds: Schema.Array(Schema.String),
});
export type CsvDeleteRowsRequest = typeof CsvDeleteRowsRequest.Type;

export const CsvInsertRowPlacement = Schema.Literals(['above', 'below', 'append']);
export type CsvInsertRowPlacement = typeof CsvInsertRowPlacement.Type;

export const CsvInsertRowRequest = Schema.Struct({
  workingCsvId: Schema.String,
  placement: CsvInsertRowPlacement,
  rowIds: Schema.Array(Schema.String),
  hasActiveQuery: Schema.Boolean,
});
export type CsvInsertRowRequest = typeof CsvInsertRowRequest.Type;

export const CsvRenameColumnRequest = Schema.Struct({
  workingCsvId: Schema.String,
  column: Schema.String,
  name: Schema.String,
});
export type CsvRenameColumnRequest = typeof CsvRenameColumnRequest.Type;

export const CsvColumnPlacement = Schema.Literals(['before', 'after']);
export type CsvColumnPlacement = typeof CsvColumnPlacement.Type;

export const CsvInsertColumnRequest = Schema.Struct({
  workingCsvId: Schema.String,
  column: Schema.String,
  placement: CsvColumnPlacement,
});
export type CsvInsertColumnRequest = typeof CsvInsertColumnRequest.Type;

export const CsvDeleteColumnRequest = Schema.Struct({
  workingCsvId: Schema.String,
  column: Schema.String,
});
export type CsvDeleteColumnRequest = typeof CsvDeleteColumnRequest.Type;

export const CsvReorderColumnsRequest = Schema.Struct({
  workingCsvId: Schema.String,
  columns: Schema.Array(Schema.String),
});
export type CsvReorderColumnsRequest = typeof CsvReorderColumnsRequest.Type;

export const CsvEditStateRequest = Schema.Struct({ workingCsvId: Schema.String });
export type CsvEditStateRequest = typeof CsvEditStateRequest.Type;

export const CsvExportRequest = Schema.Struct({ workingCsvId: Schema.String });
export type CsvExportRequest = typeof CsvExportRequest.Type;

export const CsvViewExportRequest = Schema.Struct({
  workingCsvId: Schema.String,
  sort: Schema.optional(Schema.Array(CsvSortDescriptor)),
  filters: Schema.optional(Schema.Array(CsvFilterDescriptor)),
  search: Schema.optional(Schema.String),
});
export type CsvViewExportRequest = typeof CsvViewExportRequest.Type;

export const CloseImpact = Schema.Struct({
  hasUnexportedChanges: Schema.Boolean,
  dependentComparisons: Schema.Array(Schema.Struct({
    comparisonId: Schema.String,
    baselineName: Schema.String,
    candidateName: Schema.String,
  })),
});
export type CloseImpact = typeof CloseImpact.Type;

export const CloseWorkingCsvRequest = Schema.Struct({
  workingCsvId: Schema.String,
  confirmedImpact: Schema.optional(CloseImpact),
});
export type CloseWorkingCsvRequest = typeof CloseWorkingCsvRequest.Type;

export const OpenComparisonRequest = Schema.Struct({
  baselineId: Schema.String,
  candidateId: Schema.String,
});
export type OpenComparisonRequest = typeof OpenComparisonRequest.Type;

/** Any string array decodes as a key; the Comparison service reports an empty or duplicate key as `invalid-key-shape`. */
export const BeginComparisonRequest = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal('apply-key'),
    comparisonId: Schema.String,
    key: Schema.Array(Schema.String),
  }),
  Schema.Struct({
    kind: Schema.Literal('refresh'),
    comparisonId: Schema.String,
  }),
]);
export type BeginComparisonRequest = typeof BeginComparisonRequest.Type;

export const CancelComparisonRequest = Schema.Struct({
  comparisonId: Schema.String,
  operationId: Schema.String,
});
export type CancelComparisonRequest = typeof CancelComparisonRequest.Type;

export const ComparisonRowsMode = Schema.Literals(['differences', 'all']);
export type ComparisonRowsMode = typeof ComparisonRowsMode.Type;

export const ComparisonColumnsMode = Schema.Literals(['changed-first', 'csv-order']);
export type ComparisonColumnsMode = typeof ComparisonColumnsMode.Type;

/**
 * `offset` and `limit` decode as any number. The Comparison service reports an invalid window
 * only after it has checked that the Comparison and its result still exist.
 */
export const ComparisonWindowRequest = Schema.Struct({
  comparisonId: Schema.String,
  resultToken: Schema.String,
  offset: Schema.Number,
  limit: Schema.Number,
  rows: ComparisonRowsMode,
  columns: ComparisonColumnsMode,
});
export type ComparisonWindowRequest = typeof ComparisonWindowRequest.Type;

/** The request for one operation: its `operation` name plus that operation's fields. */
function operationRequest<const Operation extends string, const Fields extends Schema.Struct.Fields>(
  name: Operation,
  fields: Fields,
) {
  return Schema.Struct({ operation: Schema.Literal(name), ...fields });
}

/** One structured-clone-safe request for every operation available through CSV Viewer. */
export const CsvViewerRequest = Schema.Union([
  // Omit sourceId to show the picker; otherwise open a source reserved by the runtime.
  operationRequest('csv.open', { sourceId: Schema.optional(Schema.String), options: Schema.optional(CsvDialectOptions) }),
  operationRequest('csv.open-recent', { sourceId: Schema.String, options: Schema.optional(CsvDialectOptions) }),
  operationRequest('csv.reopen', { workingCsvId: Schema.String, options: Schema.optional(CsvDialectOptions) }),
  operationRequest('csv.get-recent-sources', {}),
  operationRequest('csv.get-rows', CsvRowWindowRequest.fields),
  operationRequest('csv.get-column-values', CsvColumnValuesRequest.fields),
  operationRequest('csv.get-column-value-counts', CsvColumnValueCountsRequest.fields),
  operationRequest('csv.edit-cell', CsvCellEditRequest.fields),
  operationRequest('csv.delete-rows', CsvDeleteRowsRequest.fields),
  operationRequest('csv.insert-row', CsvInsertRowRequest.fields),
  operationRequest('csv.rename-column', CsvRenameColumnRequest.fields),
  operationRequest('csv.insert-column', CsvInsertColumnRequest.fields),
  operationRequest('csv.delete-column', CsvDeleteColumnRequest.fields),
  operationRequest('csv.reorder-columns', CsvReorderColumnsRequest.fields),
  operationRequest('csv.get-edit-state', CsvEditStateRequest.fields),
  operationRequest('csv.undo', CsvEditStateRequest.fields),
  operationRequest('csv.redo', CsvEditStateRequest.fields),
  operationRequest('csv.export', CsvExportRequest.fields),
  operationRequest('csv.export-view', CsvViewExportRequest.fields),
  operationRequest('csv.close', CloseWorkingCsvRequest.fields),
  operationRequest('comparison.get-candidates', { baselineId: Schema.String }),
  operationRequest('comparison.open', OpenComparisonRequest.fields),
  BeginComparisonRequest.mapMembers(Tuple.map(Schema.fieldsAssign({ operation: Schema.Literal('comparison.begin') }))),
  operationRequest('comparison.cancel', CancelComparisonRequest.fields),
  operationRequest('comparison.get-window', ComparisonWindowRequest.fields),
  operationRequest('comparison.swap', { comparisonId: Schema.String }),
  operationRequest('comparison.close', { comparisonId: Schema.String }),
]);
export type CsvViewerRequest = typeof CsvViewerRequest.Type;
