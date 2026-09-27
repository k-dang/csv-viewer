import type {
  CsvViewer,
  CsvViewerRequest,
  CsvViewerTransportValue,
} from '@csv-viewer/workspace/csv-viewer';
import { isCsvViewerRequestEnvelope } from '@csv-viewer/workspace/csv-viewer';
import { genericWorkspaceFailure, isExpectedWorkspaceError, WorkspaceRequestError } from '@csv-viewer/workspace/errors';
import path from 'node:path';
import { Schema } from 'effect';
import type { CsvViewerIpcResponse } from '../csv-viewer-ipc-response';
import { ipcChannels } from '../ipc-channels';

type CsvViewerIpcMain = {
  handle(
    channel: string,
    listener: (
      event: Electron.IpcMainInvokeEvent,
      request: CsvViewerTransportValue,
    ) => Promise<CsvViewerIpcResponse<unknown>>,
  ): void;
};

/** Registers the single mechanical request bridge from Electron to CsvViewer. */
export function registerCsvViewerRequestHandler(ipc: CsvViewerIpcMain, viewer: CsvViewer): void {
  ipc.handle(ipcChannels.request, async (_event, request) => {
    if (!isCsvViewerRequestEnvelope(request)) {
      return { ok: false, message: 'Malformed CSV Viewer request.' };
    }
    try {
      // SAFETY: The envelope guard establishes an operation string; workspace dispatch owns field validation.
      return { ok: true, value: await viewer.call(request as CsvViewerRequest) };
    } catch (error) {
      // The shared entry adapter has already translated this request failure.
      return { ok: false, message: error instanceof Error ? error.message : genericWorkspaceFailure };
    }
  });
}

/** Registers dropped-file acquisition, which does not enter the shared workspace adapter. */
export function registerDroppedSourceHandler(
  ipc: CsvViewerIpcMain,
  acquire: (filePath: string) => Promise<string>,
): void {
  ipc.handle(ipcChannels.acquireDroppedSource, async (_event, filePath) => {
    try {
      if (!Schema.is(Schema.String)(filePath) || !path.isAbsolute(filePath)) {
        throw new WorkspaceRequestError({ message: 'Drop a file from your device.' });
      }
      return { ok: true, value: await acquire(filePath) };
    } catch (error) {
      return { ok: false, message: isExpectedWorkspaceError(error) ? error.message : genericWorkspaceFailure };
    }
  });
}
