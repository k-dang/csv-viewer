import type { CsvViewer } from '../shared/csv-viewer-contract';

/** The composition root is the only renderer module that reads the Electron preload bridge. */
export function electronCsvViewer(): CsvViewer {
  return (window as unknown as { csvViewer: CsvViewer }).csvViewer;
}
