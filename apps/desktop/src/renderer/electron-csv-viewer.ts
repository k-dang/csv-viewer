import type { CsvSourceId, CsvViewer } from '@csv-viewer/workspace/csv-viewer';

declare global {
  interface Window {
    csvViewer: CsvViewer;
    acquireDroppedCsvSource: (file: File) => Promise<CsvSourceId>;
  }
}

/** The composition root is the only renderer module that reads the Electron preload bridge. */
export function electronCsvViewer(): CsvViewer {
  return window.csvViewer;
}

export function acquireDroppedCsvSource(file: File): Promise<CsvSourceId> {
  return window.acquireDroppedCsvSource(file);
}
