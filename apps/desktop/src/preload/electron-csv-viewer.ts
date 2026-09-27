import type {
  CsvViewer,
  CsvViewerEvent,
  CsvViewerRequest,
  CsvViewerResult,
} from '@csv-viewer/workspace/csv-viewer';
import { electronCsvViewerCapabilities } from '../electron-csv-viewer-capabilities';
import { ipcChannels } from '../ipc-channels';
import { unwrapCsvViewerIpcResponse, type CsvViewerIpcResponse } from '../csv-viewer-ipc-response';

export type CsvViewerIpcRenderer = {
  invoke<Request extends CsvViewerRequest>(
    channel: string,
    request: Request,
  ): Promise<CsvViewerIpcResponse<CsvViewerResult<Request>>>;
  on(
    channel: string,
    listener: (ipcEvent: Electron.IpcRendererEvent, event: CsvViewerEvent) => void,
  ): void;
  removeListener(
    channel: string,
    listener: (ipcEvent: Electron.IpcRendererEvent, event: CsvViewerEvent) => void,
  ): void;
};

/** Creates the renderer-side CsvViewer proxy without restating any product operations. */
export function createElectronCsvViewer(
  ipc: CsvViewerIpcRenderer,
): CsvViewer {
  return {
    capabilities: electronCsvViewerCapabilities,
    call: async (request) => unwrapCsvViewerIpcResponse(await ipc.invoke(ipcChannels.request, request)),
    onEvent: (callback) => {
      const listener = (_ipcEvent: Electron.IpcRendererEvent, event: CsvViewerEvent) => callback(event);
      ipc.on(ipcChannels.event, listener);
      return () => ipc.removeListener(ipcChannels.event, listener);
    },
  };
}
