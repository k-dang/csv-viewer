import { describe, expect, it, vi } from 'vitest';
import { ipcChannels } from '../ipc-channels';
import type { CsvViewerEvent } from '@csv-viewer/workspace/csv-viewer';
import { createElectronCsvViewer, type CsvViewerIpcRenderer } from './electron-csv-viewer';

describe('Electron CsvViewer proxy', () => {
  it('carries requests and results unchanged', async () => {
    const result = [{ sourceId: 'source-1' }];
    const invoke = vi.fn().mockResolvedValue({ ok: true, value: result });
    const ipc: CsvViewerIpcRenderer = { invoke, on: vi.fn(), removeListener: vi.fn() };
    const viewer = createElectronCsvViewer(ipc);
    const request = { operation: 'csv.get-recent-sources' } as const;

    await expect(viewer.call(request)).resolves.toBe(result);
    expect(invoke).toHaveBeenCalledWith(ipcChannels.request, request);
  });

  it('forwards events and removes the exact listener on unsubscribe', () => {
    let listener: ((ipcEvent: Electron.IpcRendererEvent, event: CsvViewerEvent) => void) | undefined;
    const on = vi.fn((_channel, registered) => {
      listener = registered;
    });
    const removeListener = vi.fn();
    const ipc: CsvViewerIpcRenderer = { invoke: vi.fn(), on, removeListener };
    const viewer = createElectronCsvViewer(ipc);
    const received = vi.fn();

    const unsubscribe = viewer.onEvent(received);
    if (!listener) throw new Error('Event listener was not registered.');
    // SAFETY: The proxy ignores the Electron event object.
    listener({} as Electron.IpcRendererEvent, { type: 'intent', intent: 'open-csv' });
    unsubscribe();

    expect(received).toHaveBeenCalledExactlyOnceWith({ type: 'intent', intent: 'open-csv' });
    expect(removeListener).toHaveBeenCalledWith(ipcChannels.event, listener);
  });
});
