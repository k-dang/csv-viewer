import type {
  CsvViewer,
  CsvViewerEvent,
  CsvViewerRequest,
  CsvViewerResult,
  CsvViewerTransportValue,
} from '../shared/csv-viewer-contract';
import { isCsvViewerIntent } from '../shared/csv-viewer-contract';
import { electronCsvViewerCapabilities } from '../shared/electron-csv-viewer-capabilities';
import { ipcChannels } from '../shared/ipc-channels';

export type CsvViewerEventPayload = CsvViewerTransportValue;

export type CsvViewerIpcRenderer = {
  invoke<Request extends CsvViewerRequest>(
    channel: string,
    request: Request,
  ): Promise<CsvViewerResult<Request>>;
  on(
    channel: string,
    listener: (event: Electron.IpcRendererEvent, value: CsvViewerEventPayload) => void,
  ): void;
  removeListener(
    channel: string,
    listener: (event: Electron.IpcRendererEvent, value: CsvViewerEventPayload) => void,
  ): void;
};

/** Creates the renderer-side CsvViewer proxy without restating any product operations. */
export function createElectronCsvViewer(
  ipc: CsvViewerIpcRenderer,
): CsvViewer {
  return {
    capabilities: electronCsvViewerCapabilities,
    call: (request) => ipc.invoke(ipcChannels.request, request),
    onEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, value: CsvViewerEventPayload) => {
        if (isCsvViewerEvent(value)) callback(value);
      };
      ipc.on(ipcChannels.event, listener);
      return () => ipc.removeListener(ipcChannels.event, listener);
    },
  };
}

/** The main process owns event payloads. Check their routing fields before trusting that channel. */
function isCsvViewerEvent(value: CsvViewerEventPayload): value is CsvViewerEvent {
  if (!(value instanceof Object) || Array.isArray(value)) return false;
  const type = Object.getOwnPropertyDescriptor(value, 'type')?.value;
  if (type === 'intent') {
    const intent = Object.getOwnPropertyDescriptor(value, 'intent')?.value;
    return isCsvViewerIntent(intent);
  }
  if (type !== 'comparison') return false;

  const event = Object.getOwnPropertyDescriptor(value, 'event')?.value;
  if (!(event instanceof Object)) return false;
  const kind = Object.getOwnPropertyDescriptor(event, 'kind')?.value;
  if (kind === 'closed') {
    const comparisonId = Object.getOwnPropertyDescriptor(event, 'comparisonId')?.value;
    return Object.prototype.toString.call(comparisonId) === '[object String]';
  }
  const comparison = Object.getOwnPropertyDescriptor(event, 'comparison')?.value;
  return kind === 'changed' && comparison instanceof Object;
}
