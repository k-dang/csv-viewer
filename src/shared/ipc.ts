export type HealthStatus = {
  ok: true;
  process: 'main';
  timestamp: string;
};

export type CsvColumn = {
  name: string;
  type: string;
};

export type CsvFileMetadata = {
  path: string;
  name: string;
  sizeBytes: number;
};

export type CsvDialectOptions = {
  delimiter?: string;
  header?: boolean;
};

export const csvInternalRowIdField = '__csvViewerRowId' as const;

export type CsvSessionMetadata = {
  sessionId: string;
  dataRevision: number;
  file: CsvFileMetadata;
  columns: CsvColumn[];
  rowCount: number;
  dialect: CsvDialectOptions;
};

export type RecentCsvFile = CsvFileMetadata & {
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
  sessionId: string;
  offset: number;
  limit: number;
  sort?: CsvSortDescriptor[];
  filters?: CsvFilterDescriptor[];
  search?: string;
};

export type CsvRowWindow = {
  sessionId: string;
  offset: number;
  rows: CsvRow[];
  filteredRowCount: number;
};

export type CsvColumnValueCountsRequest = {
  sessionId: string;
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
  sessionId: string;
  column: string;
  scopeRowCount: number;
  values: CsvColumnValueCount[];
};

export type CsvCellEditRequest = {
  sessionId: string;
  rowId: string;
  column: string;
  value: string;
};

export type CsvCellEditResult = {
  sessionId: string;
  rowId: string;
  column: string;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
};

export type CsvDeleteRowsRequest = {
  sessionId: string;
  rowIds: string[];
};

export type CsvInsertRowPlacement = 'above' | 'below' | 'append';

export type CsvInsertRowRequest = {
  sessionId: string;
  placement: CsvInsertRowPlacement;
  rowIds: string[];
  hasActiveQuery: boolean;
};

export type CsvEditStateRequest = {
  sessionId: string;
};

export type CsvSaveAsRequest = {
  sessionId: string;
};

export type CsvEditState = {
  sessionId: string;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
};

export type OpenCsvResult =
  | { status: 'opened'; session: CsvSessionMetadata }
  | { status: 'already-open'; session: CsvSessionMetadata }
  | { status: 'cancelled' };

export type CsvCloseResult = { status: 'closed' } | { status: 'cancelled' };

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
  workingCsv: CsvSessionMetadata;
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

export type ComparisonView = {
  comparisonId: string;
  version: number;
  baseline: CsvSessionMetadata;
  candidate: CsvSessionMetadata;
  availableKeyColumns: string[];
  operation: null | {
    operationId: string;
    intent: 'apply-key' | 'refresh';
    phase: ComparisonPhase;
  };
  applied: null | {
    key: string[];
    resultToken: string;
    freshness: { kind: 'current' } | { kind: 'outdated'; changedSides: ComparisonSide[] };
    summary: ComparisonSummary;
  };
  lastAttempt: ComparisonAttemptOutcomeView | null;
};

export type ComparisonEvent =
  | { kind: 'changed'; comparison: ComparisonView }
  | { kind: 'closed'; comparisonId: string };

export type OpenComparisonResult =
  | { status: 'created' | 'existing'; comparison: ComparisonView }
  | { status: 'rejected'; fault: ComparisonFault };

export type BeginComparisonRequest =
  | { kind: 'apply-key'; comparisonId: string; key: string[] }
  | { kind: 'refresh'; comparisonId: string };

export type BeginComparisonResult =
  | { status: 'accepted'; operationId: string }
  | { status: 'busy'; activeOperationId: string }
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

export type ComparisonWindowRequest = {
  comparisonId: string;
  resultToken: string;
  offset: number;
  limit: number;
  rows: ComparisonRowsMode;
  columns: ComparisonColumnsMode;
};

export type ComparisonWindow = {
  comparisonId: string;
  resultToken: string;
  offset: number;
  totalRowCount: number;
  keyColumns: string[];
  valueColumns: Array<{ name: string; changedRowCount: number }>;
  rows: ComparisonRow[];
};

export type ComparisonWindowOutcome =
  | { status: 'ready'; window: ComparisonWindow }
  | { status: 'result-replaced'; currentResultToken: string | null }
  | { status: 'comparison-not-found' }
  | { status: 'rejected'; fault: ComparisonFault };

export type ComparisonMutationOutcome =
  | { status: 'changed'; comparison: ComparisonView }
  | { status: 'rejected'; fault: ComparisonFault };

export type CsvViewerApi = {
  healthCheck: () => Promise<HealthStatus>;
  openCsv: (options?: CsvDialectOptions) => Promise<OpenCsvResult>;
  openRecentCsv: (path: string, options?: CsvDialectOptions) => Promise<OpenCsvResult>;
  reopenCsv: (sessionId: string, options?: CsvDialectOptions) => Promise<OpenCsvResult>;
  closeCsv: (sessionId: string) => Promise<CsvCloseResult>;
  getComparisonCandidates: (baselineId: string) => Promise<ComparisonCandidate[]>;
  openComparison: (baselineId: string, candidateId: string) => Promise<OpenComparisonResult>;
  getComparisonState: (comparisonId: string) => Promise<ComparisonView | null>;
  beginComparison: (request: BeginComparisonRequest) => Promise<BeginComparisonResult>;
  cancelComparison: (comparisonId: string, operationId: string) => Promise<CancelComparisonResult>;
  getComparisonWindow: (request: ComparisonWindowRequest) => Promise<ComparisonWindowOutcome>;
  swapComparison: (comparisonId: string) => Promise<ComparisonMutationOutcome>;
  closeComparison: (
    comparisonId: string,
  ) => Promise<{ status: 'closed' } | { status: 'failed'; failure: ComparisonFailure }>;
  onComparisonEvent: (callback: (event: ComparisonEvent) => void) => () => void;
  getRecentFiles: () => Promise<RecentCsvFile[]>;
  getCsvRows: (request: CsvRowWindowRequest) => Promise<CsvRowWindow>;
  getCsvColumnValueCounts: (request: CsvColumnValueCountsRequest) => Promise<CsvColumnValueCounts>;
  editCsvCell: (request: CsvCellEditRequest) => Promise<CsvCellEditResult>;
  deleteCsvRows: (request: CsvDeleteRowsRequest) => Promise<CsvEditState>;
  insertCsvRow: (request: CsvInsertRowRequest) => Promise<CsvEditState>;
  getCsvEditState: (request: CsvEditStateRequest) => Promise<CsvEditState>;
  saveCsvAs: (request: CsvSaveAsRequest) => Promise<CsvEditState | { status: 'cancelled' }>;
  undoCsvEdit: (request: CsvEditStateRequest) => Promise<CsvEditState>;
  redoCsvEdit: (request: CsvEditStateRequest) => Promise<CsvEditState>;
  onOpenCsvRequest: (callback: () => void) => () => void;
  onReopenCsvRequest: (callback: () => void) => () => void;
  onCloseTabRequest: (callback: () => void) => () => void;
};

export const ipcChannels = {
  healthCheck: 'app:health-check',
  openCsv: 'csv:open',
  openRecentCsv: 'csv:open-recent',
  reopenCsv: 'csv:reopen',
  closeCsv: 'csv:close',
  getComparisonCandidates: 'comparison:candidates',
  openComparison: 'comparison:open',
  getComparisonState: 'comparison:get-state',
  beginComparison: 'comparison:begin',
  cancelComparison: 'comparison:cancel',
  getComparisonWindow: 'comparison:get-window',
  swapComparison: 'comparison:swap',
  closeComparison: 'comparison:close',
  comparisonStateChanged: 'comparison:state-changed',
  getRecentFiles: 'csv:get-recent-files',
  getCsvRows: 'csv:get-rows',
  getCsvColumnValueCounts: 'csv:get-column-value-counts',
  editCsvCell: 'csv:edit-cell',
  deleteCsvRows: 'csv:delete-rows',
  insertCsvRow: 'csv:insert-row',
  getCsvEditState: 'csv:get-edit-state',
  saveCsvAs: 'csv:save-as',
  undoCsvEdit: 'csv:undo-edit',
  redoCsvEdit: 'csv:redo-edit',
  menuOpenCsv: 'menu:open-csv',
  menuReopenCsv: 'menu:reopen-csv',
  menuCloseTab: 'menu:close-tab',
} as const;
