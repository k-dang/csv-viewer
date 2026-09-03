import type { CsvViewer } from '@csv-viewer/workspace/csv-viewer';

declare global {
  interface Window {
    csvViewer: CsvViewer;
  }
}

/** The composition root is the only renderer module that reads the Electron preload bridge. */
export function electronCsvViewer(): CsvViewer {
  return window.csvViewer;
}
