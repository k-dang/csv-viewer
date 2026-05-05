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

export type CsvEditState = {
  sessionId: string;
  dirty: boolean;
  canUndo: boolean;
  canRedo: boolean;
};

export type OpenCsvResult =
  | { status: 'opened'; session: CsvSessionMetadata }
  | { status: 'cancelled' };

export type CsvViewerApi = {
  healthCheck: () => Promise<HealthStatus>;
  openCsv: (options?: CsvDialectOptions) => Promise<OpenCsvResult>;
  openRecentCsv: (path: string, options?: CsvDialectOptions) => Promise<OpenCsvResult>;
  reopenCsv: (options?: CsvDialectOptions) => Promise<OpenCsvResult>;
  getRecentFiles: () => Promise<RecentCsvFile[]>;
  getCsvRows: (request: CsvRowWindowRequest) => Promise<CsvRowWindow>;
  editCsvCell: (request: CsvCellEditRequest) => Promise<CsvCellEditResult>;
  deleteCsvRows: (request: CsvDeleteRowsRequest) => Promise<CsvEditState>;
  insertCsvRow: (request: CsvInsertRowRequest) => Promise<CsvEditState>;
  getCsvEditState: (request: CsvEditStateRequest) => Promise<CsvEditState>;
  undoCsvEdit: (request: CsvEditStateRequest) => Promise<CsvEditState>;
  redoCsvEdit: (request: CsvEditStateRequest) => Promise<CsvEditState>;
  onOpenCsvRequest: (callback: () => void) => () => void;
  onReopenCsvRequest: (callback: () => void) => () => void;
};

export const ipcChannels = {
  healthCheck: 'app:health-check',
  openCsv: 'csv:open',
  openRecentCsv: 'csv:open-recent',
  reopenCsv: 'csv:reopen',
  getRecentFiles: 'csv:get-recent-files',
  getCsvRows: 'csv:get-rows',
  editCsvCell: 'csv:edit-cell',
  deleteCsvRows: 'csv:delete-rows',
  insertCsvRow: 'csv:insert-row',
  getCsvEditState: 'csv:get-edit-state',
  undoCsvEdit: 'csv:undo-edit',
  redoCsvEdit: 'csv:redo-edit',
  menuOpenCsv: 'menu:open-csv',
  menuReopenCsv: 'menu:reopen-csv',
} as const;
