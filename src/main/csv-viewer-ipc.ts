import type {
  CsvViewer,
  CsvViewerRequest,
  CsvViewerRequestPayload,
  CsvViewerResult,
} from '../shared/csv-viewer-contract';
import { isCsvViewerRequestEnvelope } from '../shared/csv-viewer-contract';
import { ipcChannels } from '../shared/ipc-channels';

type CsvViewerIpcMain = {
  handle(
    channel: string,
    listener: (
      event: Electron.IpcMainInvokeEvent,
      request: CsvViewerRequestPayload,
    ) => Promise<CsvViewerResult<CsvViewerRequest>>,
  ): void;
};

/** Registers the single mechanical request bridge from Electron to CsvViewer. */
export function registerCsvViewerRequestHandler(ipc: CsvViewerIpcMain, viewer: CsvViewer): void {
  ipc.handle(ipcChannels.request, (_event, request) => {
    if (!isCsvViewerRequestEnvelope(request)) {
      throw new Error('Malformed CSV Viewer request.');
    }
    // SAFETY: The workspace dispatcher validates the operation-specific fields before using them.
    return viewer.call(request as CsvViewerRequest);
  });
}
