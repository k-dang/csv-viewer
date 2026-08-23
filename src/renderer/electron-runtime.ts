import type { CsvViewerRuntime } from '../shared/csv-viewer-contract';

/**
 * The one place the renderer reads the Electron preload bridge. The global is deliberately left
 * undeclared, so everything else must take the runtime from the composition root and the same React
 * tree runs against the web and test runtimes.
 */
export function electronCsvViewerRuntime(): CsvViewerRuntime {
  return (window as unknown as { csvViewer: CsvViewerRuntime }).csvViewer;
}
