import type { CsvViewerCapabilities } from '@csv-viewer/workspace/csv-viewer';

/** Electron can reopen persisted Recent CSV Sources. */
export const electronCsvViewerCapabilities: CsvViewerCapabilities = { recentCsvSources: true };
