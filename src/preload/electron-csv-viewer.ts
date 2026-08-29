import type { CsvViewer, CsvViewerEvent } from '../shared/csv-viewer-contract';
import { isCsvViewerIntent } from '../shared/csv-viewer-contract';
import { electronCsvViewerCapabilities } from '../shared/electron-csv-viewer-capabilities';
import { ipcChannels } from '../shared/ipc-channels';

/** Creates the renderer-side CsvViewer proxy without restating any product operations. */
export function createElectronCsvViewer(
  ipc: Pick<Electron.IpcRenderer, 'invoke' | 'on' | 'removeListener'>,
): CsvViewer {
  return {
    capabilities: electronCsvViewerCapabilities,
    call: (request) => ipc.invoke(ipcChannels.request, request),
    onEvent: (callback) => {
      const listener = (_event: Electron.IpcRendererEvent, value: unknown) => {
        if (hasCsvViewerEventShape(value)) callback(value as CsvViewerEvent);
      };
      ipc.on(ipcChannels.event, listener);
      return () => ipc.removeListener(ipcChannels.event, listener);
    },
  };
}

/** The main process owns event payloads. Check their routing shape before trusting that channel. */
function hasCsvViewerEventShape(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const event = value as Record<string, unknown>;
  if (event.type === 'intent') return isCsvViewerIntent(event.intent);
  if (event.type !== 'comparison' || !event.event || typeof event.event !== 'object') return false;
  const comparisonEvent = event.event as Record<string, unknown>;
  if (comparisonEvent.kind === 'closed') return typeof comparisonEvent.comparisonId === 'string';
  return comparisonEvent.kind === 'changed' && Boolean(comparisonEvent.comparison) && typeof comparisonEvent.comparison === 'object';
}
