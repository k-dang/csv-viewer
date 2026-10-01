import type { CsvWorkspaceOwner } from '@csv-viewer/workspace/csv-workspace';
import { genericWorkspaceFailure, type WorkspaceRequestError } from '@csv-viewer/workspace/errors';
import path from 'node:path';
import { Cause, Effect, Exit, Schema } from 'effect';
import type { CsvSourceUnavailableError } from '@csv-viewer/workspace/workspace-host';
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
  acquire: (filePath: string) => Effect.Effect<string, CsvSourceUnavailableError | WorkspaceRequestError>,
): void {
  ipc.handle(ipcChannels.acquireDroppedSource, async (_event, filePath) => {
    if (!Schema.is(Schema.String)(filePath) || !path.isAbsolute(filePath)) {
      return { ok: false, message: 'Drop a file from your device.' };
    }
    const exit = await Effect.runPromiseExit(Effect.suspend(() => acquire(filePath)));
    if (Exit.isSuccess(exit)) return { ok: true, value: exit.value };
    const [reason] = exit.cause.reasons;
    const message = !Cause.hasDies(exit.cause) && reason?._tag === 'Fail'
      ? reason.error.message : genericWorkspaceFailure;
    return { ok: false, message };
  });
}
