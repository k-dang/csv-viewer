import { describe, expect, it, vi } from 'vitest';
import { electronCsvViewerCapabilities } from '../shared/electron-csv-viewer-capabilities';
import type { CsvViewer, CsvViewerRequest } from '../shared/csv-viewer-contract';
import { ipcChannels } from '../shared/ipc-channels';
import { registerCsvViewerRequestHandler } from './csv-viewer-ipc';

function setup(call: CsvViewer['call']) {
  let handler: ((_event: unknown, request: unknown) => unknown) | undefined;
  const ipc = {
    handle: vi.fn((channel: string, registered: typeof handler) => {
      expect(channel).toBe(ipcChannels.request);
      handler = registered;
    }),
  };
  registerCsvViewerRequestHandler(ipc as never, {
    capabilities: electronCsvViewerCapabilities,
    call,
    onEvent: () => () => {},
  });
  if (!handler) throw new Error('IPC request handler was not registered.');
  return handler;
}

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
    const call = vi.fn(async (_request: CsvViewerRequest) => result) as CsvViewer['call'];
    const handler = setup(call);

    await expect(handler({}, request)).resolves.toBe(result);
    expect(call).toHaveBeenCalledWith(request);
  });

  it('rejects malformed request envelopes before they reach CsvViewer', async () => {
    const call = vi.fn() as CsvViewer['call'];
    const handler = setup(call);

    await expect(Promise.resolve().then(() => handler({}, { operation: 42 }))).rejects.toThrow(
      'Malformed CSV Viewer request.',
    );
    expect(call).not.toHaveBeenCalled();
  });

  it('preserves CsvViewer rejection for an unsupported operation', async () => {
    const call = vi.fn(async () => {
      throw new Error('Unsupported CSV Viewer operation: csv.unknown');
    }) as CsvViewer['call'];
    const handler = setup(call);
    const request = { operation: 'csv.unknown' };

    await expect(handler({}, request)).rejects.toThrow('Unsupported CSV Viewer operation: csv.unknown');
    expect(call).toHaveBeenCalledWith(request);
  });
});
