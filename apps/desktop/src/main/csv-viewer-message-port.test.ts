import { MessageChannel, type MessagePort } from 'node:worker_threads';
import { Deferred, Effect, Exit, Layer, Scope } from 'effect';
import { RpcServer } from 'effect/rpc';
import { describe, expect, it } from 'vitest';
import type { CsvViewerEvent } from '@csv-viewer/workspace/csv-viewer';
import type { WorkspaceDatabase } from '@csv-viewer/workspace/database';
import { connectMessagePortClient } from '@csv-viewer/workspace/csv-viewer-client';
import { dataMessagePort, messagePortServerLayer } from '@csv-viewer/workspace/csv-viewer-message-port';
import { CsvViewerRpcs } from '@csv-viewer/workspace/csv-viewer-rpcs';
import { createCsvViewer, type CsvWorkspaceServer } from '@csv-viewer/workspace/csv-workspace';
import type { CsvWorkspaceHost } from '@csv-viewer/workspace/workspace-host';

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

async function serve(workspace: CsvWorkspaceServer, port: MessagePort): Promise<() => Promise<void>> {
  const scope = await Effect.runPromise(Scope.make());
  await Effect.runPromise(Layer.buildWithScope(
    RpcServer.layer(CsvViewerRpcs).pipe(
      Layer.provide(messagePortServerLayer(dataMessagePort(port))),
      Layer.provide(Layer.succeedContext(workspace.handlerContext)),
    ),
    scope,
  ));
  return () => Effect.runPromise(Scope.close(scope, Exit.void));
}

describe('CSV Viewer MessagePort', () => {
  it('serves a request and keeps a malformed payload out of the response', async () => {
    const workspace = await createCsvViewer(Effect.succeed(database()), host());
    const { port1, port2 } = new MessageChannel();
    const close = await serve(workspace, port1);
    const viewer = await connectMessagePortClient(dataMessagePort(port2), capabilities);
    try {
      await expect(viewer.call({ operation: 'csv.get-recent-sources' })).resolves.toEqual([]);
      const response = await new Promise<unknown>((resolve) => {
        port2.on('message', resolve);
        port2.postMessage({
          _tag: 'Request',
          id: 'hostile',
          tag: 'csv.open',
          payload: { sourceId: { PRIVATE: 'SECRET-PAYLOAD' } },
          headers: [],
        });
      });
      expect(JSON.stringify(response)).not.toContain('PRIVATE');
      expect(JSON.stringify(response)).toContain('Malformed CSV Viewer request.');
    } finally {
      await viewer.close();
      await close();
      await workspace.dispose();
    }
  });

  it('interrupts the server fiber when the client fiber is interrupted', async () => {
    const entered = Deferred.makeUnsafe<void>();
    const interrupted = Deferred.makeUnsafe<void>();
    const workspace = await createCsvViewer(Effect.succeed(database()), host(), {
      acquireDroppedPath: () => Effect.suspend(() => {
        Deferred.doneUnsafe(entered, Exit.void);
        return Effect.never;
      }).pipe(Effect.onInterrupt(() => Deferred.done(interrupted, Exit.void))),
    });
    const { port1, port2 } = new MessageChannel();
    const close = await serve(workspace, port1);
    const viewer = await connectMessagePortClient(dataMessagePort(port2), capabilities);
    const pending = viewer.acquireDroppedPath('/tmp/data.csv');
    await Effect.runPromise(Deferred.await(entered));
    await viewer.close();
    await expect(pending).rejects.toThrow('The CSV workspace could not complete the request.');
    await Effect.runPromise(Deferred.await(interrupted).pipe(Effect.timeout('2 seconds')));
    await close();
    await workspace.dispose();
  });

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
    const { port1, port2 } = new MessageChannel();
    const close = await serve(workspace, port1);
    const viewer = await connectMessagePortClient(dataMessagePort(port2), capabilities);
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
      await close();
      await workspace.dispose();
    }
  });

  it('drops the events listener when the client closes without unsubscribing', async () => {
    const workspace = await createCsvViewer(Effect.succeed(database()), host());
    const { port1, port2 } = new MessageChannel();
    const close = await serve(workspace, port1);
    const viewer = await connectMessagePortClient(dataMessagePort(port2), capabilities);
    const received = Promise.withResolvers<string>();
    viewer.onEvent((event) => {
      if (event.type === 'intent') received.resolve(event.intent);
    });
    try {
      await expect.poll(() => eventListeners(workspace).size, { timeout: 2000 }).toBe(1);
      workspace.publishIntent('open-csv');
      await expect(received.promise).resolves.toBe('open-csv');
      await viewer.close();
      await expect.poll(() => eventListeners(workspace).size, { timeout: 2000 }).toBe(0);
    } finally {
      await close();
      await workspace.dispose();
    }
  });
});

function eventListeners(workspace: CsvWorkspaceServer): ReadonlySet<(event: CsvViewerEvent) => void> {
  // SAFETY: CsvWorkspaceImplementation stores `onEvent` subscribers on `listeners`. TypeScript marks that field private.
  const implementation = workspace as CsvWorkspaceServer & {
    readonly listeners: ReadonlySet<(event: CsvViewerEvent) => void>;
  };
  return implementation.listeners;
}
