import type { CsvViewerCapabilities } from './csv-viewer-contract';

/** Electron can reopen persisted Recent CSV Sources. */
export const electronCsvViewerCapabilities: CsvViewerCapabilities = { recentCsvSources: true };
