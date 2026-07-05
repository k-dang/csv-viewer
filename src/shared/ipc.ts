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

export type CsvViewerApi = {
  healthCheck: () => Promise<HealthStatus>;
  openCsv: (options?: CsvDialectOptions) => Promise<OpenCsvResult>;
  openRecentCsv: (path: string, options?: CsvDialectOptions) => Promise<OpenCsvResult>;
  reopenCsv: (sessionId: string, options?: CsvDialectOptions) => Promise<OpenCsvResult>;
  closeCsv: (sessionId: string) => Promise<CsvCloseResult>;
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
