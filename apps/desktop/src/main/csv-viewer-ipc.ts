import type { CsvWorkspaceOwner } from '@csv-viewer/workspace/csv-workspace';
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
      // Renderer payloads are untrusted; each handler decodes its own.
      // oxlint-disable-next-line anti-slop/no-unknown-parameters
      payload: unknown,
    ) => Promise<CsvViewerIpcResponse<unknown>>,
  ): void;
};

/** Registers the single mechanical request bridge from Electron to CsvViewer. The workspace decodes each payload. */
export function registerCsvViewerRequestHandler(ipc: CsvViewerIpcMain, workspace: Pick<CsvWorkspaceOwner, 'receive'>): void {
  ipc.handle(ipcChannels.request, async (_event, payload) => {
    try {
      return { ok: true, value: await workspace.receive(payload) };
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
