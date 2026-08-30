import { describe, expect, it, vi } from 'vitest';
import { ipcChannels } from '../shared/ipc-channels';
import {
  createElectronCsvViewer,
  type CsvViewerEventPayload,
  type CsvViewerIpcRenderer,
} from './electron-csv-viewer';

describe('Electron CsvViewer proxy', () => {
  it('carries requests and results unchanged', async () => {
    const result = [{ sourceId: 'source-1' }];
    const invoke = vi.fn().mockResolvedValue(result);
    const ipc: CsvViewerIpcRenderer = { invoke, on: vi.fn(), removeListener: vi.fn() };
    const viewer = createElectronCsvViewer(ipc);
    const request = { operation: 'csv.get-recent-sources' } as const;

    await expect(viewer.call(request)).resolves.toBe(result);
    expect(invoke).toHaveBeenCalledWith(ipcChannels.request, request);
  });

  it('validates events and removes the exact listener on unsubscribe', () => {
    let listener: ((event: Electron.IpcRendererEvent, value: CsvViewerEventPayload) => void) | undefined;
    const on = vi.fn((_channel, registered) => {
      listener = registered;
    });
    const removeListener = vi.fn();
    const ipc: CsvViewerIpcRenderer = { invoke: vi.fn(), on, removeListener };
    const viewer = createElectronCsvViewer(ipc);
    const received = vi.fn();

    const unsubscribe = viewer.onEvent(received);
    if (!listener) throw new Error('Event listener was not registered.');
    // SAFETY: The proxy ignores the Electron event object; this test drives only the payload parser.
    const event = {} as Electron.IpcRendererEvent;
    listener(event, { type: 'intent', intent: 'open-csv' });
    listener(event, { type: 'intent', intent: 'unknown' });
    listener(event, { type: 'comparison', event: { kind: 'changed' } });
    listener(event, { type: 'comparison', event: { kind: 'closed' } });
    listener(
      event,
      { type: 'comparison', event: { kind: 'closed', comparisonId: 'comparison-1' } },
    );
    unsubscribe();

    expect(received).toHaveBeenCalledTimes(2);
    expect(received).toHaveBeenNthCalledWith(1, { type: 'intent', intent: 'open-csv' });
    expect(received).toHaveBeenNthCalledWith(2, {
      type: 'comparison',
      event: { kind: 'closed', comparisonId: 'comparison-1' },
    });
    expect(removeListener).toHaveBeenCalledWith(ipcChannels.event, listener);
  });
});
