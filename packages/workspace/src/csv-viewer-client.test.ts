import { Deferred, Effect, Exit } from 'effect';
import { describe, expect, it } from 'vitest';
import { connectInProcessClient } from './csv-viewer-client';
import { createCsvViewer } from './csv-workspace';
import type { WorkspaceDatabase } from './database';
import type { CsvWorkspaceHost } from './workspace-host';

const capabilities = { recentCsvSources: false, exportCsvSuccessMessage: '', warnOnPageUnload: false };

function host(): CsvWorkspaceHost {
  return {
    capabilities,
    acquireSource: () => Effect.succeed(null),
    releaseSource: () => undefined,
    describeSource: () => Effect.die('unused'),
    acquireEngineSource: () => { throw new Error('unused'); },
    deliverExport: () => Effect.succeed({ status: 'cancelled' }),
    recentSources: () => Effect.succeed([]),
    recordRecentSource: () => Effect.void,
    confirmDiscardChanges: () => Effect.succeed(true),
  };
}

function database(): WorkspaceDatabase {
  const unexpected = () => { throw new Error('No database work expected.'); };
  return { ownerConnection: unexpected, connectWorker: unexpected, run: unexpected, readObjects: unexpected };
}

describe('in-process CSV Viewer RPC', () => {
  it('resolves a different in-flight call when one handler dies', async () => {
    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const workspace = await createCsvViewer(Effect.succeed(database()), {
      ...host(),
      recentSources: () => Effect.die(new Error('recent sources exploded')),
    }, {
      acquireDroppedPath: () => Effect.gen(function* () {
        Deferred.doneUnsafe(entered, Exit.void);
        yield* Deferred.await(release);
        return 'dropped-source';
      }),
    });
    const viewer = await connectInProcessClient(workspace);
    const pending = viewer.acquireDroppedPath('/tmp/data.csv');
    try {
      await Effect.runPromise(Deferred.await(entered));
      await expect(viewer.call({ operation: 'csv.get-recent-sources' })).rejects.toThrow(
        'The CSV workspace could not complete the request.',
      );
      Deferred.doneUnsafe(release, Exit.void);
      await expect(pending).resolves.toBe('dropped-source');
    } finally {
      if (!Deferred.isDoneUnsafe(release)) Deferred.doneUnsafe(release, Exit.void);
      await pending.catch(() => undefined);
      await viewer.close();
      await workspace.dispose();
    }
  });
});
