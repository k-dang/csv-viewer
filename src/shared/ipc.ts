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

export type CsvRowWindowRequest = {
  sessionId: string;
  offset: number;
  limit: number;
};

export type CsvRowWindow = {
  sessionId: string;
  offset: number;
  rows: CsvRow[];
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
