export type HealthStatus = {
  ok: true;
  process: 'main';
  timestamp: string;
};

export type CsvViewerApi = {
  healthCheck: () => Promise<HealthStatus>;
};

export const ipcChannels = {
  healthCheck: 'app:health-check',
} as const;
