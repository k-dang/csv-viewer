import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import type { CsvWorkspaceOwner } from '@csv-viewer/workspace/csv-workspace';
import { ipcChannels } from '../ipc-channels';
import { registerCsvViewerRequestHandler, registerDroppedSourceHandler } from './csv-viewer-ipc';
import { createElectronCsvViewer, type CsvViewerIpcRenderer } from '../preload/electron-csv-viewer';
import { unwrapCsvViewerIpcResponse } from '../csv-viewer-ipc-response';
import { CsvSourceUnavailableError } from '@csv-viewer/workspace/workspace-host';

function setup(receive: CsvWorkspaceOwner['receive']) {
  type Ipc = Parameters<typeof registerCsvViewerRequestHandler>[0];
  type Handler = Parameters<Ipc['handle']>[1];
  let handler: Handler | undefined;
  const ipc: Ipc = {
    handle: vi.fn((channel: string, registered: Handler) => {
      expect(channel).toBe(ipcChannels.request);
      handler = registered;
    }),
  };
  registerCsvViewerRequestHandler(ipc, { receive });
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
    const handler = setup(vi.fn(async () => result));
    expect(structuredClone(await handler(ipcEvent, { operation: 'csv.open' }))).toEqual({ ok: true, value: result });
  });

  it('forwards the raw payload and returns the exact result', async () => {
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
    const receive = vi.fn(async () => result);
    const handler = setup(receive);

    await expect(handler(ipcEvent, request)).resolves.toEqual({ ok: true, value: result });
    expect(receive).toHaveBeenCalledWith(request);
  });

  it('returns a rejected request to the renderer without an Electron prefix', async () => {
    const handler = setup(vi.fn(async () => { throw new Error('CSV column name cannot be blank.'); }));
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
    registerDroppedSourceHandler(ipc, () => Effect.fail(new CsvSourceUnavailableError({ code: 'missing-source', message: 'The CSV Source no longer exists.' })));
    if (!handler) throw new Error('Dropped-source handler was not registered.');
    const missingPath = path.resolve('PRIVATE-MISSING.csv');
    const missing = await handler(ipcEvent, missingPath);
    expect(() => unwrapCsvViewerIpcResponse(missing)).toThrow(/^The CSV Source no longer exists\.$/);

    registerDroppedSourceHandler(ipc, () => Effect.die(new Error('PRIVATE internal failure at C:\\PRIVATE-MISSING.csv')));
    const unexpected = await handler(ipcEvent, missingPath);
    expect(unexpected).toEqual({ ok: false, message: 'The CSV workspace could not complete the request.' });
    expect(JSON.stringify(unexpected)).not.toContain('PRIVATE');

    const unexpectedAcquire = () => Effect.fail(new Error('PRIVATE unexpected failure at C:\\PRIVATE-MISSING.csv'));
    // SAFETY: Deliberately violates the host's typed failure contract to test IPC sanitization.
    registerDroppedSourceHandler(ipc, unexpectedAcquire as never);
    await expect(handler(ipcEvent, missingPath)).resolves.toEqual({
      ok: false, message: 'The CSV workspace could not complete the request.',
    });

    registerDroppedSourceHandler(ipc, () => Effect.die(new CsvSourceUnavailableError({ code: 'unreadable', message: 'PRIVATE unexpected source error.' })));
    await expect(handler(ipcEvent, missingPath)).resolves.toEqual({
      ok: false, message: 'The CSV workspace could not complete the request.',
    });
  });
});
