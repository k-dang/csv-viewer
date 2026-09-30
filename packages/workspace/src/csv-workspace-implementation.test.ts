import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import type { CsvSourceId } from './csv-viewer';
import type { OwnedWorkspaceDatabase } from './database';
import type { CsvWorkspaceHost } from './workspace-host';
import { createCsvViewer } from './csv-workspace';

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
      acquireEngineSource: () => { throw new Error('Source must not open after disposal.'); },
      deliverExport: async () => ({ status: 'cancelled' }),
      recentSources: async () => [],
      recordRecentSource: async () => undefined,
      confirmDiscardChanges: async () => true,
    };
    const unexpected = () => { throw new Error('No database work expected.'); };
    const database: OwnedWorkspaceDatabase = {
      ownerConnection: unexpected,
      connectWorker: unexpected,
      run: unexpected,
      readObjects: unexpected,
      ownerConnectionEffect: unexpected,
      connectWorkerEffect: unexpected,
      runEffect: unexpected,
      readObjectsEffect: unexpected,
      closeOwnerConnection: () => Effect.void,
      closeEngine: () => Effect.void,
    };
    const workspace = await createCsvViewer(Effect.succeed(database), host);
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
