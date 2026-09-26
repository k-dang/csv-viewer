import { describe, expect, it, vi } from 'vitest';
import type { CsvSourceId } from './csv-viewer';
import type { WorkspaceDatabase } from './database';
import type { CsvWorkspaceHost } from './workspace-host';
import { CsvWorkspaceImplementation } from './csv-workspace-implementation';

describe('CSV source selection during workspace disposal', () => {
  it('finishes disposal while the picker is pending and releases a later selection', async () => {
    const selected = Promise.withResolvers<CsvSourceId | null>();
    const pickerEntered = Promise.withResolvers<void>();
    const releaseSource = vi.fn();
    const host: CsvWorkspaceHost = {
      capabilities: { recentCsvSources: false, exportCsvSuccessMessage: '', warnOnPageUnload: false },
      acquireSource: () => {
        pickerEntered.resolve();
        return selected.promise;
      },
      releaseSource,
      describeSource: async () => { throw new Error('Source must not open after disposal.'); },
      withEngineSource: async () => { throw new Error('Source must not open after disposal.'); },
      deliverExport: async () => ({ status: 'cancelled' }),
      recentSources: async () => [],
      recordRecentSource: async () => undefined,
      confirmDiscardChanges: async () => true,
    };
    const database: WorkspaceDatabase = {
      ownerConnection: async () => { throw new Error('No database work expected.'); },
      connectWorker: async () => { throw new Error('No database work expected.'); },
      isOpen: () => true,
      run: async () => { throw new Error('No database work expected.'); },
      readObjects: async () => { throw new Error('No database work expected.'); },
      close: vi.fn(async () => []),
    };
    const workspace = new CsvWorkspaceImplementation(host, database);
    const opening = workspace.call({ operation: 'csv.open' });
    await pickerEntered.promise;
    let disposed = false;
    const disposal = workspace.dispose().then(() => { disposed = true; });

    try {
      await vi.waitUntil(() => disposed, { interval: 1, timeout: 1000 });
    } finally {
      selected.resolve('selected.csv');
      await Promise.all([opening.catch(() => undefined), disposal.catch(() => undefined)]);
    }

    await expect(opening).resolves.toEqual({ status: 'failed', message: 'The CSV workspace is closing.' });
    expect(releaseSource).toHaveBeenCalledExactlyOnceWith('selected.csv');

    await expect(workspace.call({ operation: 'csv.open', sourceId: 'reserved.csv' })).resolves.toEqual({
      status: 'failed', message: 'The CSV workspace is closing.',
    });
    expect(releaseSource).toHaveBeenNthCalledWith(2, 'reserved.csv');
    await expect(workspace.call({ operation: 'csv.open' })).resolves.toEqual({
      status: 'failed', message: 'The CSV workspace is closing.',
    });
    expect(releaseSource).toHaveBeenCalledTimes(2);
  });
});
