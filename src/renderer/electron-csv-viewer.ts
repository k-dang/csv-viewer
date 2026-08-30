import type { CsvViewer } from '../shared/csv-viewer-contract';

declare global {
  interface Window {
    csvViewer: CsvViewer;
  }
}

/** The composition root is the only renderer module that reads the Electron preload bridge. */
export function electronCsvViewer(): CsvViewer {
  return window.csvViewer;
}
