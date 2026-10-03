import type {
  CloseImpact,
  CsvDialectOptions,
  CsvViewerRequest,
} from './csv-viewer-requests';

export type * from './csv-viewer-requests';

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

export type CsvRowWindow = {
  workingCsvId: WorkingCsvId;
  offset: number;
  rows: CsvRow[];
  filteredRowCount: number;
  totalRowCount: number;
};

export type CsvColumnValues = {
  workingCsvId: WorkingCsvId;
  column: string;
  values: CsvCellValue[];
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

export type CsvCellEditResult = {
  workingCsvId: WorkingCsvId;
  rowId: string;
  column: string;
  hasUnexportedChanges: boolean;
  canUndo: boolean;
  canRedo: boolean;
};

/** Tagged like every other outcome in this contract, so a second non-success arm costs no caller a reshape. */
export type CsvExportOutcome = { status: 'exported'; editState: CsvEditState } | { status: 'cancelled' };

export type CsvViewExportOutcome = { status: 'exported'; rowCount: number } | { status: 'cancelled' | 'empty' };
export type CancelViewExportOutcome = { status: 'requested' | 'already-finished' | 'operation-mismatch' };
export type CsvViewExportEvent = { workingCsvId: WorkingCsvId; operationId: string; phase: 'delivering' };

export type CsvEditState = {
  workingCsvId: WorkingCsvId;
  hasUnexportedChanges: boolean;
  canUndo: boolean;
  canRedo: boolean;
};

export type CsvSchemaEditState = CsvEditState & {
  columns: CsvColumn[];
};

export type OpenCsvResult =
  | { status: 'opened'; workingCsv: WorkingCsvView }
  | { status: 'already-open'; workingCsv: WorkingCsvView }
  | CsvCapacityExceeded
  | { status: 'failed'; message: string }
  | { status: 'cancelled' };

export type CsvCapacityExceeded = {
  status: 'capacity-exceeded';
  limit: 'source-bytes' | 'workspace-source-bytes';
  limitBytes: number;
  message: string;
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

export type ComparisonRow = {
  classification: 'changed' | 'baseline-only' | 'candidate-only' | 'unchanged';
  keyValues: string[];
  baseline: { rowId: string; values: Array<string | null> } | null;
  candidate: { rowId: string; values: Array<string | null> } | null;
  changed: boolean[];
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
export type CsvViewerIntent = 'open-csv' | 'reopen-csv' | 'export-csv' | 'close-tab';

/**
 * Genuine differences between runtimes, stated up front rather than discovered through failures.
 * A capability is declared once a caller reads it.
 */
export type CsvViewerCapabilities = {
  /** Recent CSV Sources can be listed and reopened. False when source identity does not outlive the session. */
  recentCsvSources: boolean;
  /** Copy shown after the runtime has accepted an Export CSV for delivery. */
  exportCsvSuccessMessage: string;
  /** Browser navigation should be guarded while Working CSVs have Unexported Changes. */
  warnOnPageUnload: boolean;
};

/** The result of each operation. `csv-viewer-requests.ts` defines each operation's request. */
export type CsvViewerOperationMap = {
  'csv.open': OpenCsvResult;
  'csv.open-recent': OpenCsvResult;
  'csv.reopen': OpenCsvResult;
  'csv.get-recent-sources': RecentCsvSource[];
  'csv.get-rows': CsvRowWindow;
  'csv.get-column-values': CsvColumnValues;
  'csv.get-column-value-counts': CsvColumnValueCounts;
  'csv.edit-cell': CsvCellEditResult;
  'csv.delete-rows': CsvEditState;
  'csv.insert-row': CsvEditState;
  'csv.rename-column': CsvSchemaEditState;
  'csv.insert-column': CsvSchemaEditState;
  'csv.delete-column': CsvSchemaEditState;
  'csv.get-edit-state': CsvEditState;
  'csv.undo': CsvSchemaEditState;
  'csv.redo': CsvSchemaEditState;
  'csv.export': CsvExportOutcome;
  'csv.export-view': CsvViewExportOutcome;
  'csv.cancel-view-export': CancelViewExportOutcome;
  'csv.close': CloseWorkingCsvOutcome;
  'comparison.get-candidates': ComparisonCandidate[];
  'comparison.open': OpenComparisonResult;
  'comparison.begin': BeginComparisonResult;
  'comparison.cancel': CancelComparisonResult;
  'comparison.get-window': ComparisonWindowOutcome;
  'comparison.swap': ComparisonMutationOutcome;
  'comparison.close': CloseComparisonResult;
};

/** Distributes over `Request`, so a caller holding a union of requests gets the union of results. */
export type CsvViewerResult<Request extends CsvViewerRequest> = Request extends CsvViewerRequest
  ? CsvViewerOperationMap[Request['operation']]
  : never;

export type CsvViewerEvent =
  | { type: 'view-export'; event: CsvViewExportEvent }
  | { type: 'comparison'; event: ComparisonEvent }
  | { type: 'intent'; intent: CsvViewerIntent }
  | { type: 'fatal-error'; message: string };

export interface CsvViewer {
  readonly capabilities: CsvViewerCapabilities;
  call<Request extends CsvViewerRequest>(request: Request): Promise<CsvViewerResult<Request>>;
  onEvent(listener: (event: CsvViewerEvent) => void): () => void;
}
