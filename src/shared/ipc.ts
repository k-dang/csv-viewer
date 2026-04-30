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

export type OpenCsvResult =
  | { status: 'opened'; session: CsvSessionMetadata }
  | { status: 'cancelled' };

export type CsvViewerApi = {
  healthCheck: () => Promise<HealthStatus>;
  openCsv: () => Promise<OpenCsvResult>;
};

export const ipcChannels = {
  healthCheck: 'app:health-check',
  openCsv: 'csv:open',
} as const;
