import { describe, expect, it, vi } from 'vitest';
import { electronCsvViewerCapabilities } from '../shared/electron-csv-viewer-capabilities';
import type { CsvViewer, CsvViewerRequest } from '../shared/csv-viewer-contract';
import { ipcChannels } from '../shared/ipc-channels';
import { registerCsvViewerRequestHandler } from './csv-viewer-ipc';

function setup(call: CsvViewer['call']) {
  type Ipc = Parameters<typeof registerCsvViewerRequestHandler>[0];
  type Handler = Parameters<Ipc['handle']>[1];
  let handler: Handler | undefined;
  const ipc: Ipc = {
    handle: vi.fn((channel: string, registered: Handler) => {
      expect(channel).toBe(ipcChannels.request);
      handler = registered;
    }),
  };
  registerCsvViewerRequestHandler(ipc, {
    capabilities: electronCsvViewerCapabilities,
    call,
    onEvent: () => () => {},
  });
  if (!handler) throw new Error('IPC request handler was not registered.');
  return handler;
}

// SAFETY: The registered handler does not inspect Electron's invoke-event object.
const ipcEvent = {} as Electron.IpcMainInvokeEvent;

describe('CsvViewer Electron request bridge', () => {
  it('forwards a valid request and returns the exact result', async () => {
    const request = { operation: 'csv.get-recent-sources' } as const;
    const result = [
      {
        sourceId: 'source-1',
        name: 'people.csv',
        location: 'C:/people.csv',
        sizeBytes: 10,
        lastOpenedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    // SAFETY: This fixture handles the one request used by the test with its matching result type.
    const call = vi.fn(async (_request: CsvViewerRequest) => result) as CsvViewer['call'];
    const handler = setup(call);

    await expect(handler(ipcEvent, request)).resolves.toBe(result);
    expect(call).toHaveBeenCalledWith(request);
  });

  it('rejects malformed request envelopes before they reach CsvViewer', async () => {
    // SAFETY: The malformed request must be rejected before this call function can run.
    const call = vi.fn() as CsvViewer['call'];
    const handler = setup(call);

    await expect(Promise.resolve().then(() => handler(ipcEvent, { operation: 42 }))).rejects.toThrow(
      'Malformed CSV Viewer request.',
    );
    expect(call).not.toHaveBeenCalled();
  });

  it('preserves CsvViewer rejection for an unsupported operation', async () => {
    // SAFETY: This fixture intentionally rejects every request before returning a result.
    const call = vi.fn(async () => {
      throw new Error('Unsupported CSV Viewer operation: csv.unknown');
    }) as CsvViewer['call'];
    const handler = setup(call);
    const request = { operation: 'csv.unknown' };

    await expect(handler(ipcEvent, request)).rejects.toThrow('Unsupported CSV Viewer operation: csv.unknown');
    expect(call).toHaveBeenCalledWith(request);
  });
});
