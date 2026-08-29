import type { CsvViewer, CsvViewerRequest } from '../shared/csv-viewer-contract';
import { isCsvViewerRequestEnvelope } from '../shared/csv-viewer-contract';
import { ipcChannels } from '../shared/ipc-channels';

/** Registers the single mechanical request bridge from Electron to CsvViewer. */
export function registerCsvViewerRequestHandler(ipc: Pick<Electron.IpcMain, 'handle'>, viewer: CsvViewer): void {
  ipc.handle(ipcChannels.request, (_event, request: unknown) => {
    if (!isCsvViewerRequestEnvelope(request)) {
      throw new Error('Malformed CSV Viewer request.');
    }
    return viewer.call(request as CsvViewerRequest);
  });
}
