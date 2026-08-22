export type HealthStatus = {
  ok: true;
  process: 'main';
  timestamp: string;
};

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

export type CsvFileMetadata = {
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
  file: CsvFileMetadata;
  columns: CsvColumn[];
  rowCount: number;
  dialect: CsvDialectOptions;
  editState: CsvEditState;
};

export type WorkingCsvRef = Pick<WorkingCsvView, 'workingCsvId' | 'file' | 'columns'>;

export type WorkingCsvFailure = {
  code: 'open-failed' | 'replace-failed';
  message: string;
  retryable: boolean;
};

export type OpenWorkingCsvOutcome =
  | { status: 'opened'; workingCsv: WorkingCsvView }
  | { status: 'existing'; workingCsv: WorkingCsvView }
  | { status: 'failed'; failure: WorkingCsvFailure };

export type ReplaceWorkingCsvOutcome =
  | { status: 'replaced'; workingCsv: WorkingCsvView }
  | { status: 'working-csv-not-found' }
  | { status: 'failed'; failure: WorkingCsvFailure };

export type RecentCsvSource = CsvFileMetadata & {
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

export type CsvTextFilterOperator =
  | 'contains'
  | 'notContains'
  | 'equals'
  | 'notEqual'
  | 'startsWith'
  | 'endsWith';

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
  duplicateExamples: Array<{ keyValues: string[]; rowCount: number; rowIds: string[] }>;
};

export type ComparisonKeyDiagnostics = {
  key: string[];
  baseline: SourceKeyDiagnostics;
  candidate: SourceKeyDiagnostics;
};

export type ComparisonAttemptOutcomeView =
  | { attemptId: string; status: 'applied' }
  | { attemptId: string; status: 'invalid-key'; diagnostics: ComparisonKeyDiagnostics }
  | { attemptId: string; status: 'cancelled' }
  | { attemptId: string; status: 'sources-changed'; changedSides: ComparisonSide[] }
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

export type BeginComparisonIpcResult =
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
  | { status: 'result-replaced'; currentResultToken: ComparisonResultToken | null }
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

/** Hosts validate what crosses their boundary before it reaches React. */
export function isCsvViewerIntent(value: unknown): value is CsvViewerIntent {
  return csvViewerIntents.includes(value as CsvViewerIntent);
}

/**
 * Genuine differences between runtimes, stated up front rather than discovered through failures.
 * A capability is declared once a caller reads it: export delivery, cancellation immediacy, and the
 * capacity envelope join this type in the tickets that introduce their first consumer, which are
 * also the tickets that establish their real shape.
 */
export type CsvViewerRuntimeCapabilities = {
  /** Recent CSV Sources can be listed and reopened. False when source identity does not outlive the session. */
  recentCsvSources: boolean;
};

/**
 * The domain operations the shared workspace owns. `CsvWorkspace implements` this, and the host
 * contract below is derived from it, so one declaration fixes each operation's shape and a host
 * gaining a capability can never break the runtime-neutral workspace.
 */
export type CsvWorkspaceOperations = {
  openCsv: (options?: CsvDialectOptions) => Promise<OpenCsvResult>;
  openRecentCsv: (sourceId: CsvSourceId, options?: CsvDialectOptions) => Promise<OpenCsvResult>;
  closeCsv: (request: CloseWorkingCsvRequest) => Promise<CloseWorkingCsvOutcome>;
  getComparisonCandidates: (baselineId: WorkingCsvId) => Promise<ComparisonCandidate[]>;
  openComparison: (request: OpenComparisonRequest) => Promise<OpenComparisonResult>;
  getComparisonState: (comparisonId: ComparisonId) => Promise<ComparisonView | null>;
  beginComparison: (request: BeginComparisonRequest) => Promise<BeginComparisonIpcResult>;
  cancelComparison: (request: CancelComparisonRequest) => Promise<CancelComparisonResult>;
  getComparisonWindow: (request: ComparisonWindowRequest) => Promise<ComparisonWindowOutcome>;
  swapComparison: (comparisonId: ComparisonId) => Promise<ComparisonMutationOutcome>;
  closeComparison: (comparisonId: ComparisonId) => Promise<CloseComparisonResult>;
  onComparisonEvent: (callback: (event: ComparisonEvent) => void) => () => void;
  getRecentCsvSources: () => Promise<RecentCsvSource[]>;
  getCsvRows: (request: CsvRowWindowRequest) => Promise<CsvRowWindow>;
  getCsvColumnValueCounts: (request: CsvColumnValueCountsRequest) => Promise<CsvColumnValueCounts>;
  editCsvCell: (request: CsvCellEditRequest) => Promise<CsvCellEditResult>;
  deleteCsvRows: (request: CsvDeleteRowsRequest) => Promise<CsvEditState>;
  insertCsvRow: (request: CsvInsertRowRequest) => Promise<CsvEditState>;
  getCsvEditState: (request: CsvEditStateRequest) => Promise<CsvEditState>;
  exportCsv: (request: CsvExportRequest) => Promise<CsvEditState | { status: 'cancelled' }>;
  undoCsvEdit: (request: CsvEditStateRequest) => Promise<CsvEditState>;
  redoCsvEdit: (request: CsvEditStateRequest) => Promise<CsvEditState>;
  reopenCsv: (
    workingCsvId: WorkingCsvId,
    options?: CsvDialectOptions,
  ) => Promise<ReplaceWorkingCsvOutcome>;
};

/**
 * The renderer's only view of its host: the workspace surface, explicit capabilities, and intent
 * subscriptions. Desktop supplies an IPC proxy over the main-process workspace, web supplies
 * in-page wiring, and tests supply a plain object.
 *
 * `reopenCsv` is restated because the host owns it: it wraps the workspace operation in a discard
 * confirmation and can therefore report `cancelled`, which the workspace has no notion of.
 */
export type CsvViewerRuntime = Omit<CsvWorkspaceOperations, 'reopenCsv'> & {
  capabilities: CsvViewerRuntimeCapabilities;
  healthCheck: () => Promise<HealthStatus>;
  reopenCsv: (workingCsvId: WorkingCsvId, options?: CsvDialectOptions) => Promise<OpenCsvResult>;
  onIntent: (callback: (intent: CsvViewerIntent) => void) => () => void;
};

