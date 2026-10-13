import type { ConnectedCsvViewer } from '@csv-viewer/workspace/csv-viewer-client';

declare global {
  interface Window {
    csvViewer?: ConnectedCsvViewer;
    csvViewerPathForFile: (file: File) => string;
  }
}

export function pathForDroppedFile(file: File): string {
  const filePath = window.csvViewerPathForFile(file);
  if (!filePath) throw new Error('Drop a file from your device.');
  return filePath;
}
