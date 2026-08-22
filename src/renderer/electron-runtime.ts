import type { CsvViewerRuntime } from '../shared/csv-viewer-contract';

declare global {
  interface Window {
    csvViewer: CsvViewerRuntime;
  }
}

/**
 * The one place the renderer reads the Electron preload bridge. Everything else takes the runtime
 * from the composition root, so the same React tree runs against the web and test runtimes.
 */
export function electronCsvViewerRuntime(): CsvViewerRuntime {
  return window.csvViewer;
}
