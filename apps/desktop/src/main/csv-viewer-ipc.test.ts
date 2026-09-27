import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { electronCsvViewerCapabilities } from '../electron-csv-viewer-capabilities';
import type { CsvViewer, CsvViewerRequest } from '@csv-viewer/workspace/csv-viewer';
import { ipcChannels } from '../ipc-channels';
import { registerCsvViewerRequestHandler, registerDroppedSourceHandler } from './csv-viewer-ipc';
import { createElectronCsvViewer, type CsvViewerIpcRenderer } from '../preload/electron-csv-viewer';
import { unwrapCsvViewerIpcResponse } from '../csv-viewer-ipc-response';
import { CsvSourceUnavailableError } from '@csv-viewer/workspace/workspace-host';

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
  it('transports the shared capacity outcome with its limit and desktop fallback', async () => {
    const result = {
      status: 'capacity-exceeded',
      limit: 'source-bytes',
      limitBytes: 100_000_000,
      message: 'CSV Viewer Web supports files up to 100 MB. Use the desktop application for larger files.',
    } as const;
    // SAFETY: This fixture handles only csv.open, whose result includes capacity rejection.
    const call = vi.fn(async () => result) as CsvViewer['call'];
    const handler = setup(call);
    expect(structuredClone(await handler(ipcEvent, { operation: 'csv.open' }))).toEqual({ ok: true, value: result });
  });

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

    await expect(handler(ipcEvent, request)).resolves.toEqual({ ok: true, value: result });
    expect(call).toHaveBeenCalledWith(request);
  });

  it('rejects malformed request envelopes before they reach CsvViewer', async () => {
    // SAFETY: The malformed request must be rejected before this call function can run.
    const call = vi.fn() as CsvViewer['call'];
    const handler = setup(call);

    await expect(handler(ipcEvent, { operation: 42 })).resolves.toEqual({ ok: false, message: 'Malformed CSV Viewer request.' });
    expect(call).not.toHaveBeenCalled();
  });

  it('preserves CsvViewer rejection for an unsupported operation', async () => {
    // SAFETY: This fixture intentionally rejects every request before returning a result.
    const call = vi.fn(async () => {
      throw new Error('Unsupported CSV Viewer operation: csv.unknown');
    }) as CsvViewer['call'];
    const handler = setup(call);
    const request = { operation: 'csv.unknown' };

    await expect(handler(ipcEvent, request)).resolves.toEqual({ ok: false, message: 'Unsupported CSV Viewer operation: csv.unknown' });
    expect(call).toHaveBeenCalledWith(request);
  });

  it('returns a rejected request to the renderer without an Electron prefix', async () => {
    // SAFETY: This fixture only exercises the rejection path.
    const call = vi.fn(async () => { throw new Error('CSV column name cannot be blank.'); }) as CsvViewer['call'];
    const handler = setup(call);
    const ipc: CsvViewerIpcRenderer = {
      // SAFETY: This fake invoke returns the registered response for the one request under test.
      invoke: vi.fn((_channel, request) => handler(ipcEvent, request)) as CsvViewerIpcRenderer['invoke'],
      on: vi.fn(),
      removeListener: vi.fn(),
    };
    const viewer = createElectronCsvViewer(ipc);
    await expect(viewer.call({ operation: 'csv.rename-column', workingCsvId: 'csv', column: 'name', name: ' ' }))
      .rejects.toThrow(/^CSV column name cannot be blank\.$/);
  });

  it('sanitizes dropped-source failures before the preload rethrows them', async () => {
    type Ipc = Parameters<typeof registerDroppedSourceHandler>[0];
    let handler: Parameters<Ipc['handle']>[1] | undefined;
    const ipc: Ipc = { handle: (_channel, registered) => { handler = registered; } };
    registerDroppedSourceHandler(ipc, async () => {
      throw new CsvSourceUnavailableError('missing-source', 'The CSV Source no longer exists.');
    });
    if (!handler) throw new Error('Dropped-source handler was not registered.');
    const missingPath = path.resolve('PRIVATE-MISSING.csv');
    const missing = await handler(ipcEvent, missingPath);
    expect(() => unwrapCsvViewerIpcResponse(missing)).toThrow(/^The CSV Source no longer exists\.$/);

    registerDroppedSourceHandler(ipc, async () => {
      throw new Error('PRIVATE internal failure at C:\\PRIVATE-MISSING.csv');
    });
    const unexpected = await handler(ipcEvent, missingPath);
    expect(unexpected).toEqual({ ok: false, message: 'The CSV workspace could not complete the request.' });
    expect(JSON.stringify(unexpected)).not.toContain('PRIVATE');
  });
});
