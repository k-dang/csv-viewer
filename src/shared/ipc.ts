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

export type CsvSessionMetadata = {
  sessionId: string;
  file: CsvFileMetadata;
  columns: CsvColumn[];
  rowCount: number;
};

export type CsvCellValue = string | number | boolean | null;

export type CsvRow = Record<string, CsvCellValue>;

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
};

export type CsvRowWindow = {
  sessionId: string;
  offset: number;
  rows: CsvRow[];
  filteredRowCount: number;
};

export type OpenCsvResult =
  | { status: 'opened'; session: CsvSessionMetadata }
  | { status: 'cancelled' };

export type CsvViewerApi = {
  healthCheck: () => Promise<HealthStatus>;
  openCsv: () => Promise<OpenCsvResult>;
  getCsvRows: (request: CsvRowWindowRequest) => Promise<CsvRowWindow>;
};

export const ipcChannels = {
  healthCheck: 'app:health-check',
  openCsv: 'csv:open',
  getCsvRows: 'csv:get-rows',
} as const;
