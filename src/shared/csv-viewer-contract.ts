export type WorkingCsvId = string;
/** Opaque, runtime-scoped identity of a CSV Source. Never parsed or interpreted by consumers. */
export type CsvSourceId = string;
export type ComparisonId = string;
export type ComparisonOperationId = string;
export type ComparisonResultToken = string;

export type CsvColumn = {
  name: string;
  type: string;
};

export type CsvSourceMetadata = {
  sourceId: CsvSourceId;
  name: string;
  /** Where the CSV Source lives, in whatever terms the runtime can show the user. */
  location: string;
  sizeBytes: number;
};

export type CsvDialectOptions = {
  delimiter?: string;
  header?: boolean;
};

export const csvInternalRowIdField = '__csvViewerRowId' as const;

/**
 * File types a CSV Source may use, without the leading dot. The workspace enforces this list; hosts
 * reuse it so their file pickers offer exactly what the workspace will accept.
 */
export const supportedCsvFileExtensions = ['csv', 'tsv', 'txt'] as const;

export type WorkingCsvView = {
  workingCsvId: WorkingCsvId;
  dataRevision: number;
  source: CsvSourceMetadata;
  columns: CsvColumn[];
  rowCount: number;
  dialect: CsvDialectOptions;
  editState: CsvEditState;
};

export type WorkingCsvRef = Pick<WorkingCsvView, 'workingCsvId' | 'source' | 'columns'>;

export type RecentCsvSource = CsvSourceMetadata & {
  lastOpenedAt: string;
};

export type CsvCellValue = string | null;

export type CsvRow = Record<string, CsvCellValue> & {
  [csvInternalRowIdField]: string;
};

export type CsvSortDescriptor = {
  column: string;
  direction: 'asc' | 'desc';
};

export type CsvTextFilterOperator = 'contains' | 'notContains' | 'equals' | 'notEqual' | 'startsWith' | 'endsWith';

export type CsvNumberFilterOperator =
  | 'equals'
  | 'notEqual'
  | 'greaterThan'
  | 'greaterThanOrEqual'
  | 'lessThan'
  | 'lessThanOrEqual'
  | 'inRange';

export type CsvDateFilterOperator =
  | 'equals'
  | 'notEqual'
  | 'greaterThan'
  | 'greaterThanOrEqual'
  | 'lessThan'
  | 'lessThanOrEqual'
  | 'inRange';

export type CsvBlankFilterOperator = 'blank' | 'notBlank';

export type CsvFilterDescriptor =
  | {
      column: string;
      kind: 'text';
      operator: CsvTextFilterOperator | CsvBlankFilterOperator;
      value?: string;
    }
  | {
      column: string;
      kind: 'number';
      operator: CsvNumberFilterOperator | CsvBlankFilterOperator;
      value?: number;
      valueTo?: number;
    }
  | {
      column: string;
      kind: 'date';
      operator: CsvDateFilterOperator | CsvBlankFilterOperator;
      value?: string;
      valueTo?: string;
    };

export type CsvRowWindowRequest = {
  workingCsvId: WorkingCsvId;
  offset: number;
  limit: number;
  sort?: CsvSortDescriptor[];
  filters?: CsvFilterDescriptor[];
  search?: string;
};

export type CsvRowWindow = {
  workingCsvId: WorkingCsvId;
  offset: number;
  rows: CsvRow[];
  filteredRowCount: number;
};

export type CsvColumnValueCountsRequest = {
  workingCsvId: WorkingCsvId;
  column: string;
  filters?: CsvFilterDescriptor[];
  search?: string;
};

export type CsvColumnValueCount = {
  value: CsvCellValue;
  count: number;
  percentOfScope: number;
};

export type CsvColumnValueCounts = {
  workingCsvId: WorkingCsvId;
  column: string;
  scopeRowCount: number;
  values: CsvColumnValueCount[];
};

export type CsvCellEditRequest = {
  workingCsvId: WorkingCsvId;
  rowId: string;
  column: string;
  value: string;
};

export type CsvCellEditResult = {
  workingCsvId: WorkingCsvId;
  rowId: string;
  column: string;
  hasUnexportedChanges: boolean;
  canUndo: boolean;
  canRedo: boolean;
};

export type CsvDeleteRowsRequest = {
  workingCsvId: WorkingCsvId;
  rowIds: string[];
};

export type CsvInsertRowPlacement = 'above' | 'below' | 'append';

export type CsvInsertRowRequest = {
  workingCsvId: WorkingCsvId;
  placement: CsvInsertRowPlacement;
  rowIds: string[];
  hasActiveQuery: boolean;
};

export type CsvEditStateRequest = {
  workingCsvId: WorkingCsvId;
};

export type CsvExportRequest = {
  workingCsvId: WorkingCsvId;
};

/** Tagged like every other outcome in this contract, so a second non-success arm costs no caller a reshape. */
export type CsvExportOutcome = { status: 'exported'; editState: CsvEditState } | { status: 'cancelled' };

export type CsvEditState = {
  workingCsvId: WorkingCsvId;
  hasUnexportedChanges: boolean;
  canUndo: boolean;
  canRedo: boolean;
};

export type OpenCsvResult =
  | { status: 'opened'; workingCsv: WorkingCsvView }
  | { status: 'already-open'; workingCsv: WorkingCsvView }
  | { status: 'failed'; message: string }
  | { status: 'cancelled' };

export type CloseImpact = {
  hasUnexportedChanges: boolean;
  dependentComparisons: Array<{
    comparisonId: ComparisonId;
    baselineName: string;
    candidateName: string;
  }>;
};

export type CloseWorkingCsvRequest = {
  workingCsvId: WorkingCsvId;
  confirmedImpact?: CloseImpact;
};

export type CloseWorkingCsvOutcome =
  | {
      status: 'closed';
      closedWorkingCsvId: WorkingCsvId;
      closedComparisonIds: ComparisonId[];
    }
  | { status: 'confirmation-required'; impact: CloseImpact }
  | {
      status: 'failed';
      failure: {
        code: 'source-unavailable' | 'cleanup-failed';
        message: string;
        retryable: boolean;
      };
    };

export type WorkspaceCloseImpact = {
  workingCsvsWithUnexportedChanges: Array<{
    workingCsvId: WorkingCsvId;
    sourceName: string;
  }>;
  dependentComparisons: CloseImpact['dependentComparisons'];
};

export type ConfirmWorkspaceCloseOutcome =
  | { status: 'ready' }
  | { status: 'confirmation-required'; impact: WorkspaceCloseImpact };

export type ComparisonSide = 'baseline' | 'candidate';
export type ComparisonPhase = 'validating' | 'comparing' | 'summarizing';
export type ComparisonRowsMode = 'differences' | 'all';
export type ComparisonColumnsMode = 'changed-first' | 'csv-order';

export type ComparisonFault = {
  code:
    | 'source-not-found'
    | 'comparison-not-found'
    | 'same-source'
    | 'incompatible-columns'
    | 'invalid-key-shape'
    | 'unknown-key-column'
    | 'no-applied-key'
    | 'busy'
    | 'invalid-window'
    | 'result-replaced'
    | 'operation-mismatch';
  message: string;
};

export type ComparisonCandidate = {
  workingCsv: WorkingCsvView;
  compatibility:
    | { kind: 'compatible' }
    | {
        kind: 'incompatible';
        missingFromBaseline: string[];
        missingFromCandidate: string[];
      };
};

export type OpenComparisonRequest = {
  baselineId: WorkingCsvId;
  candidateId: WorkingCsvId;
};

export type ComparisonSummary = {
  rows: {
    changed: number;
    baselineOnly: number;
    candidateOnly: number;
    unchanged: number;
    total: number;
  };
  changedColumns: Array<{ name: string; changedRowCount: number }>;
};

export type SourceKeyDiagnostics = {
  blankRowCount: number;
  duplicateGroupCount: number;
  blankExamples: Array<{ rowId: string; keyValues: Array<string | null> }>;
  duplicateExamples: Array<{
    keyValues: string[];
    rowCount: number;
    rowIds: string[];
  }>;
};

export type ComparisonKeyDiagnostics = {
  key: string[];
  baseline: SourceKeyDiagnostics;
  candidate: SourceKeyDiagnostics;
};

export type ComparisonAttemptOutcomeView =
  | { attemptId: string; status: 'applied' }
  | {
      attemptId: string;
      status: 'invalid-key';
      diagnostics: ComparisonKeyDiagnostics;
    }
  | { attemptId: string; status: 'cancelled' }
  | {
      attemptId: string;
      status: 'sources-changed';
      changedSides: ComparisonSide[];
    }
  | { attemptId: string; status: 'failed'; failure: ComparisonFailure };

export type ComparisonFailure = {
  code: 'resource-exhausted' | 'source-unavailable' | 'query-failed' | 'cleanup-failed';
  message: string;
  retryable: boolean;
};

export type CloseComparisonResult =
  | { status: 'closed'; comparisonId: ComparisonId }
  | { status: 'failed'; failure: ComparisonFailure };

export type ComparisonView = {
  comparisonId: ComparisonId;
  version: number;
  baseline: WorkingCsvRef;
  candidate: WorkingCsvRef;
  availableKeyColumns: string[];
  operation: null | {
    operationId: ComparisonOperationId;
    intent: 'apply-key' | 'refresh';
    phase: ComparisonPhase;
  };
  applied: null | {
    key: string[];
    resultToken: ComparisonResultToken;
    freshness: { kind: 'current' } | { kind: 'outdated'; changedSides: ComparisonSide[] };
    summary: ComparisonSummary;
  };
  lastAttempt: ComparisonAttemptOutcomeView | null;
};

export type ComparisonEvent =
  | { kind: 'changed'; comparison: ComparisonView }
  | { kind: 'closed'; comparisonId: ComparisonId };

export type OpenComparisonResult =
  | { status: 'created' | 'existing'; comparison: ComparisonView }
  | { status: 'rejected'; fault: ComparisonFault };

export type BeginComparisonRequest =
  | { kind: 'apply-key'; comparisonId: ComparisonId; key: string[] }
  | { kind: 'refresh'; comparisonId: ComparisonId };

export type BeginComparisonResult =
  | { status: 'accepted'; operationId: ComparisonOperationId }
  | { status: 'busy'; activeOperationId: ComparisonOperationId }
  | { status: 'rejected'; fault: ComparisonFault };

export type CancelComparisonResult =
  | { status: 'requested' }
  | { status: 'already-requested' }
  | { status: 'already-finished' }
  | { status: 'operation-mismatch' }
  | { status: 'comparison-not-found' };

export type CancelComparisonRequest = {
  comparisonId: ComparisonId;
  operationId: ComparisonOperationId;
};

export type ComparisonRow = {
  classification: 'changed' | 'baseline-only' | 'candidate-only' | 'unchanged';
  keyValues: string[];
  baseline: { rowId: string; values: Array<string | null> } | null;
  candidate: { rowId: string; values: Array<string | null> } | null;
  changed: boolean[];
};

export type ComparisonWindowRequest = {
  comparisonId: ComparisonId;
  resultToken: ComparisonResultToken;
  offset: number;
  limit: number;
  rows: ComparisonRowsMode;
  columns: ComparisonColumnsMode;
};

export type ComparisonWindow = {
  comparisonId: ComparisonId;
  resultToken: ComparisonResultToken;
  offset: number;
  totalRowCount: number;
  keyColumns: string[];
  valueColumns: Array<{ name: string; changedRowCount: number }>;
  rows: ComparisonRow[];
};

export type ComparisonWindowOutcome =
  | { status: 'ready'; window: ComparisonWindow }
  | {
      status: 'result-replaced';
      currentResultToken: ComparisonResultToken | null;
    }
  | { status: 'comparison-not-found' }
  | { status: 'rejected'; fault: ComparisonFault };

export type ComparisonMutationOutcome =
  | { status: 'changed'; comparison: ComparisonView }
  | { status: 'rejected'; fault: ComparisonFault };

/**
 * Application-level requests raised outside React - today the desktop application menu. Runtimes
 * translate their own command mechanics into these intents before they reach the renderer.
 */
export const csvViewerIntents = ['open-csv', 'reopen-csv', 'export-csv', 'close-tab'] as const;

export type CsvViewerIntent = (typeof csvViewerIntents)[number];

export function isCsvViewerIntent(value: string): value is CsvViewerIntent {
  return csvViewerIntents.some((intent) => intent === value);
}

/**
 * Genuine differences between runtimes, stated up front rather than discovered through failures.
 * A capability is declared once a caller reads it.
 */
export type CsvViewerCapabilities = {
  /** Recent CSV Sources can be listed and reopened. False when source identity does not outlive the session. */
  recentCsvSources: boolean;
};

export type CsvViewerOperationMap = {
  'csv.open': {
    request: { options?: CsvDialectOptions };
    result: OpenCsvResult;
  };
  'csv.open-recent': {
    request: { sourceId: CsvSourceId; options?: CsvDialectOptions };
    result: OpenCsvResult;
  };
  'csv.reopen': {
    request: { workingCsvId: WorkingCsvId; options?: CsvDialectOptions };
    result: OpenCsvResult;
  };
  'csv.get-recent-sources': {
    request: Record<never, never>;
    result: RecentCsvSource[];
  };
  'csv.get-rows': {
    request: CsvRowWindowRequest;
    result: CsvRowWindow;
  };
  'csv.get-column-value-counts': {
    request: CsvColumnValueCountsRequest;
    result: CsvColumnValueCounts;
  };
  'csv.edit-cell': {
    request: CsvCellEditRequest;
    result: CsvCellEditResult;
  };
  'csv.delete-rows': {
    request: CsvDeleteRowsRequest;
    result: CsvEditState;
  };
  'csv.insert-row': {
    request: CsvInsertRowRequest;
    result: CsvEditState;
  };
  'csv.get-edit-state': {
    request: CsvEditStateRequest;
    result: CsvEditState;
  };
  'csv.undo': {
    request: CsvEditStateRequest;
    result: CsvEditState;
  };
  'csv.redo': {
    request: CsvEditStateRequest;
    result: CsvEditState;
  };
  'csv.export': {
    request: CsvExportRequest;
    result: CsvExportOutcome;
  };
  'csv.close': {
    request: CloseWorkingCsvRequest;
    result: CloseWorkingCsvOutcome;
  };
  'comparison.get-candidates': {
    request: { baselineId: WorkingCsvId };
    result: ComparisonCandidate[];
  };
  'comparison.open': {
    request: OpenComparisonRequest;
    result: OpenComparisonResult;
  };
  'comparison.begin': {
    request: BeginComparisonRequest;
    result: BeginComparisonResult;
  };
  'comparison.cancel': {
    request: CancelComparisonRequest;
    result: CancelComparisonResult;
  };
  'comparison.get-window': {
    request: ComparisonWindowRequest;
    result: ComparisonWindowOutcome;
  };
  'comparison.swap': {
    request: { comparisonId: ComparisonId };
    result: ComparisonMutationOutcome;
  };
  'comparison.close': {
    request: { comparisonId: ComparisonId };
    result: CloseComparisonResult;
  };
};

/** One structured-clone-safe request for every operation available through CSV Viewer. */
export type CsvViewerRequest = {
  [Operation in keyof CsvViewerOperationMap]: {
    operation: Operation;
  } & CsvViewerOperationMap[Operation]['request'];
}[keyof CsvViewerOperationMap];

/** Distributes over `Request`, so a caller holding a union of requests gets the union of results. */
export type CsvViewerResult<Request extends CsvViewerRequest> = Request extends CsvViewerRequest
  ? CsvViewerOperationMap[Request['operation']]['result']
  : never;

export type CsvViewerEvent =
  | { type: 'comparison'; event: ComparisonEvent }
  | { type: 'intent'; intent: CsvViewerIntent };

export interface CsvViewer {
  readonly capabilities: CsvViewerCapabilities;
  call<Request extends CsvViewerRequest>(request: Request): Promise<CsvViewerResult<Request>>;
  onEvent(listener: (event: CsvViewerEvent) => void): () => void;
}

export type CsvViewerTransportValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | CsvViewerTransportValue[]
  | { [key: string]: CsvViewerTransportValue };

export type CsvViewerRequestPayload = CsvViewerTransportValue;

/** Validates the transport envelope. CsvViewer rejects unknown operation names in its dispatcher. */
export function isCsvViewerRequestEnvelope(value: CsvViewerRequestPayload): value is { operation: string } {
  if (!(value instanceof Object) || Array.isArray(value)) return false;
  const operation = Object.getOwnPropertyDescriptor(value, 'operation')?.value;
  return Object.prototype.toString.call(operation) === '[object String]';
}
