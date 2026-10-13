import { Schema } from 'effect';
import {
  CloseImpact,
  CsvDialectOptions,
} from './csv-viewer-requests';

const CsvCellValue = Schema.NullOr(Schema.String);

const CsvColumn = Schema.Struct({
  name: Schema.String,
  type: Schema.String,
});

const CsvSourceMetadata = Schema.Struct({
  sourceId: Schema.String,
  name: Schema.String,
  location: Schema.String,
  sizeBytes: Schema.Number,
});

const CsvEditState = Schema.Struct({
  workingCsvId: Schema.String,
  hasUnexportedChanges: Schema.Boolean,
  canUndo: Schema.Boolean,
  canRedo: Schema.Boolean,
});

const CsvSchemaEditState = Schema.Struct({
  ...CsvEditState.fields,
  columns: Schema.Array(CsvColumn),
});

const WorkingCsvView = Schema.Struct({
  workingCsvId: Schema.String,
  dataRevision: Schema.Number,
  source: CsvSourceMetadata,
  columns: Schema.Array(CsvColumn),
  rowCount: Schema.Number,
  dialect: CsvDialectOptions,
  editState: CsvEditState,
});

const WorkingCsvRef = Schema.Struct({
  workingCsvId: Schema.String,
  source: CsvSourceMetadata,
  columns: Schema.Array(CsvColumn),
});

export const RecentCsvSource = Schema.Struct({
  ...CsvSourceMetadata.fields,
  lastOpenedAt: Schema.String,
});

/** Visible cells plus the internal row identifier, which is itself a string cell. */
export const CsvRow = Schema.Record(Schema.String, CsvCellValue);

export const CsvRowWindow = Schema.Struct({
  workingCsvId: Schema.String,
  offset: Schema.Number,
  rows: Schema.Array(CsvRow),
  filteredRowCount: Schema.Number,
  totalRowCount: Schema.Number,
});

export const CsvColumnValues = Schema.Struct({
  workingCsvId: Schema.String,
  column: Schema.String,
  values: Schema.Array(CsvCellValue),
});

export const CsvColumnValueCounts = Schema.Struct({
  workingCsvId: Schema.String,
  column: Schema.String,
  scopeRowCount: Schema.Number,
  values: Schema.Array(Schema.Struct({
    value: CsvCellValue,
    count: Schema.Number,
    percentOfScope: Schema.Number,
  })),
});

export const CsvCellEditResult = Schema.Struct({
  workingCsvId: Schema.String,
  rowId: Schema.String,
  column: Schema.String,
  hasUnexportedChanges: Schema.Boolean,
  canUndo: Schema.Boolean,
  canRedo: Schema.Boolean,
});

export const CsvExportOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal('exported'), editState: CsvEditState }),
  Schema.Struct({ status: Schema.Literal('cancelled') }),
]);

export const CsvViewExportOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal('exported'), rowCount: Schema.Number }),
  Schema.Struct({ status: Schema.Literals(['cancelled', 'empty']) }),
]);

export const CsvCapacityExceeded = Schema.Struct({
  status: Schema.Literal('capacity-exceeded'),
  limit: Schema.Literals(['source-bytes', 'workspace-source-bytes']),
  limitBytes: Schema.Number,
  message: Schema.String,
});

export const OpenCsvResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal('opened'), workingCsv: WorkingCsvView }),
  Schema.Struct({ status: Schema.Literal('already-open'), workingCsv: WorkingCsvView }),
  CsvCapacityExceeded,
  Schema.Struct({ status: Schema.Literal('failed'), message: Schema.String }),
  Schema.Struct({ status: Schema.Literal('cancelled') }),
]);

const CloseFailure = Schema.Struct({
  code: Schema.Literals(['source-unavailable', 'cleanup-failed']),
  message: Schema.String,
  retryable: Schema.Boolean,
});

export const CloseWorkingCsvOutcome = Schema.Union([
  Schema.Struct({
    status: Schema.Literal('closed'),
    closedWorkingCsvId: Schema.String,
    closedComparisonIds: Schema.Array(Schema.String),
  }),
  Schema.Struct({ status: Schema.Literal('confirmation-required'), impact: CloseImpact }),
  Schema.Struct({ status: Schema.Literal('failed'), failure: CloseFailure }),
]);

const ComparisonFault = Schema.Struct({
  code: Schema.Literals([
    'source-not-found',
    'comparison-not-found',
    'same-source',
    'incompatible-columns',
    'invalid-key-shape',
    'unknown-key-column',
    'no-applied-key',
    'busy',
    'invalid-window',
    'result-replaced',
    'operation-mismatch',
  ]),
  message: Schema.String,
});

const ComparisonSummary = Schema.Struct({
  rows: Schema.Struct({
    changed: Schema.Number,
    baselineOnly: Schema.Number,
    candidateOnly: Schema.Number,
    unchanged: Schema.Number,
    total: Schema.Number,
  }),
  changedColumns: Schema.Array(Schema.Struct({
    name: Schema.String,
    changedRowCount: Schema.Number,
  })),
});

const SourceKeyDiagnostics = Schema.Struct({
  blankRowCount: Schema.Number,
  duplicateGroupCount: Schema.Number,
  blankExamples: Schema.Array(Schema.Struct({
    rowId: Schema.String,
    keyValues: Schema.Array(CsvCellValue),
  })),
  duplicateExamples: Schema.Array(Schema.Struct({
    keyValues: Schema.Array(Schema.String),
    rowCount: Schema.Number,
    rowIds: Schema.Array(Schema.String),
  })),
});

const ComparisonKeyDiagnostics = Schema.Struct({
  key: Schema.Array(Schema.String),
  baseline: SourceKeyDiagnostics,
  candidate: SourceKeyDiagnostics,
});

const ComparisonSide = Schema.Literals(['baseline', 'candidate']);

const ComparisonFailure = Schema.Struct({
  code: Schema.Literals(['resource-exhausted', 'source-unavailable', 'query-failed', 'cleanup-failed']),
  message: Schema.String,
  retryable: Schema.Boolean,
});

const ComparisonAttemptOutcome = Schema.Union([
  Schema.Struct({ attemptId: Schema.String, status: Schema.Literal('applied') }),
  Schema.Struct({
    attemptId: Schema.String,
    status: Schema.Literal('invalid-key'),
    diagnostics: ComparisonKeyDiagnostics,
  }),
  Schema.Struct({ attemptId: Schema.String, status: Schema.Literal('cancelled') }),
  Schema.Struct({
    attemptId: Schema.String,
    status: Schema.Literal('sources-changed'),
    changedSides: Schema.Array(ComparisonSide),
  }),
  Schema.Struct({
    attemptId: Schema.String,
    status: Schema.Literal('failed'),
    failure: ComparisonFailure,
  }),
]);

const ComparisonOperation = Schema.Struct({
  operationId: Schema.String,
  intent: Schema.Literals(['apply-key', 'refresh']),
  phase: Schema.Literals(['validating', 'comparing']),
});

const ComparisonFreshness = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('current') }),
  Schema.Struct({ kind: Schema.Literal('outdated'), changedSides: Schema.Array(ComparisonSide) }),
]);

export const ComparisonView = Schema.Struct({
  comparisonId: Schema.String,
  version: Schema.Number,
  baseline: WorkingCsvRef,
  candidate: WorkingCsvRef,
  availableKeyColumns: Schema.Array(Schema.String),
  operation: Schema.NullOr(ComparisonOperation),
  applied: Schema.NullOr(Schema.Struct({
    key: Schema.Array(Schema.String),
    resultToken: Schema.String,
    freshness: ComparisonFreshness,
    summary: ComparisonSummary,
  })),
  lastAttempt: Schema.NullOr(ComparisonAttemptOutcome),
});

export const ComparisonEvent = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('changed'), comparison: ComparisonView }),
  Schema.Struct({ kind: Schema.Literal('closed'), comparisonId: Schema.String }),
]);

export const CsvViewerEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal('comparison'), event: ComparisonEvent }),
  Schema.Struct({
    type: Schema.Literal('intent'),
    intent: Schema.Literals(['open-csv', 'reopen-csv', 'export-csv', 'close-tab']),
  }),
  Schema.Struct({ type: Schema.Literal('fatal-error'), message: Schema.String }),
]);

export const ComparisonCandidate = Schema.Struct({
  workingCsv: WorkingCsvView,
  compatibility: Schema.Union([
    Schema.Struct({ kind: Schema.Literal('compatible') }),
    Schema.Struct({
      kind: Schema.Literal('incompatible'),
      missingFromBaseline: Schema.Array(Schema.String),
      missingFromCandidate: Schema.Array(Schema.String),
    }),
  ]),
});

export const OpenComparisonResult = Schema.Union([
  Schema.Struct({
    status: Schema.Literals(['created', 'existing']),
    comparison: ComparisonView,
  }),
  Schema.Struct({ status: Schema.Literal('rejected'), fault: ComparisonFault }),
]);

export const BeginComparisonResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal('accepted'), operationId: Schema.String }),
  Schema.Struct({ status: Schema.Literal('busy'), activeOperationId: Schema.String }),
  Schema.Struct({ status: Schema.Literal('rejected'), fault: ComparisonFault }),
]);

export const CancelComparisonResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal('requested') }),
  Schema.Struct({ status: Schema.Literal('already-requested') }),
  Schema.Struct({ status: Schema.Literal('already-finished') }),
  Schema.Struct({ status: Schema.Literal('operation-mismatch') }),
  Schema.Struct({ status: Schema.Literal('comparison-not-found') }),
]);

const ComparisonRowSide = Schema.NullOr(Schema.Struct({
  rowId: Schema.String,
  values: Schema.Array(CsvCellValue),
}));

export const ComparisonWindow = Schema.Struct({
  comparisonId: Schema.String,
  resultToken: Schema.String,
  offset: Schema.Number,
  totalRowCount: Schema.Number,
  keyColumns: Schema.Array(Schema.String),
  rows: Schema.Array(Schema.Struct({
    classification: Schema.Literals(['changed', 'baseline-only', 'candidate-only', 'unchanged']),
    keyValues: Schema.Array(Schema.String),
    baseline: ComparisonRowSide,
    candidate: ComparisonRowSide,
    changed: Schema.Array(Schema.Boolean),
  })),
});

export const ComparisonWindowOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal('ready'), window: ComparisonWindow }),
  Schema.Struct({
    status: Schema.Literal('result-replaced'),
    currentResultToken: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ status: Schema.Literal('comparison-not-found') }),
  Schema.Struct({ status: Schema.Literal('rejected'), fault: ComparisonFault }),
]);

export const ComparisonMutationOutcome = Schema.Union([
  Schema.Struct({ status: Schema.Literal('changed'), comparison: ComparisonView }),
  Schema.Struct({ status: Schema.Literal('rejected'), fault: ComparisonFault }),
]);

export const CloseComparisonResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal('closed'), comparisonId: Schema.String }),
  Schema.Struct({ status: Schema.Literal('failed'), failure: ComparisonFailure }),
]);

export const CsvEditStateResult = CsvEditState;
export const CsvSchemaEditStateResult = CsvSchemaEditState;
