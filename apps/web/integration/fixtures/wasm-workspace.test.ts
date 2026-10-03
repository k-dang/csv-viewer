import WebWorker from 'web-worker';
import { AsyncDuckDB } from '@duckdb/duckdb-wasm';
import { quoteLiteral } from '../../../../packages/workspace/src/query/csv-query';
import { Effect } from 'effect';
import { expect, it, vi } from 'vitest';
import {
  SharedEngineWasmDatabase,
  WasmWorkspaceFixture,
  closeSharedWasmEngine,
} from './wasm-workspace';

it('waits for the DuckDB-Wasm worker thread to exit before completing engine shutdown', async () => {
  const fixture = await WasmWorkspaceFixture.create();
  await fixture.openSource('worker-lifecycle.csv', ['name', 'Ada'].join('\n'));
  await fixture.dispose();

  const releaseTermination = Promise.withResolvers<void>();
  const terminateWorker = WebWorker.prototype.terminate;
  const terminate = vi
    .spyOn(WebWorker.prototype, 'terminate')
    .mockImplementation(function (this: InstanceType<typeof WebWorker>) {
      void releaseTermination.promise.then(() => terminateWorker.call(this));
    });
  let closed = false;
  const shutdown = closeSharedWasmEngine().then(() => {
    closed = true;
  });

  try {
    await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(closed).toBe(false);
  } finally {
    releaseTermination.resolve();
    await shutdown;
    terminate.mockRestore();
  }
});

it('hands the next database an empty engine, dropping tables and registered files alike', async () => {
  const first = await Effect.runPromise(new SharedEngineWasmDatabase().open());
  const leaked = await Effect.runPromise(first.registerFileBuffer('leaky.csv', new TextEncoder().encode('name\nAda\n')));
  await Effect.runPromise(first.run('CREATE TABLE leftover(x INTEGER)'));
  await Effect.runPromise(first.closeOwnerConnection());
  await Effect.runPromise(first.closeEngine());

  const second = await Effect.runPromise(new SharedEngineWasmDatabase().open());
  await expect(Effect.runPromise(second.readObjects('SELECT * FROM leftover'))).rejects.toThrow();
  await expect(Effect.runPromise(second.readObjects(`SELECT * FROM read_csv('${leaked}', all_varchar = true)`)),
  ).rejects.toThrow();
  await Effect.runPromise(second.closeOwnerConnection());
  await Effect.runPromise(second.closeEngine());
});

it('retries a failed source drop after the next CSV opens', async () => {
  const fixture = await WasmWorkspaceFixture.create();
  const originalDrop = AsyncDuckDB.prototype.dropFile;
  let failedReference: string | null = null;
  const engineReady = Promise.withResolvers<AsyncDuckDB>();
  const drop = vi.spyOn(AsyncDuckDB.prototype, 'dropFile').mockImplementation(function (this: AsyncDuckDB, reference) {
    if (failedReference === null) {
      engineReady.resolve(this);
      failedReference = reference;
      return Promise.reject(new Error('PRIVATE transient source drop failure'));
    }
    return originalDrop.call(this, reference);
  });

  try {
    await fixture.openSource('first.csv', 'name\nAda\n');
    if (!failedReference) throw new Error('The first CSV did not attempt to release its engine source.');
    const inspector = await (await engineReady.promise).connect();
    try {
      const read = `SELECT * FROM read_csv(${quoteLiteral(failedReference)}, all_varchar = true)`;
      await expect(inspector.query(read)).resolves.toBeDefined();
      await fixture.openSource('second.csv', 'name\nGrace\n');
      expect(drop.mock.calls.filter(([reference]) => reference === failedReference)).toHaveLength(2);
      await expect(inspector.query(read)).rejects.toThrow();
    } finally {
      await inspector.close();
    }
  } finally {
    drop.mockRestore();
    await fixture.dispose();
  }
});
