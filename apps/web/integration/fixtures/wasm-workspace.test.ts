import WebWorker from 'web-worker';
import { Effect } from 'effect';
import { expect, it, vi } from 'vitest';
import { openInScope } from '../../../../packages/workspace/test/scoped-database';
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
  const first = await openInScope(new SharedEngineWasmDatabase().open());
  const leaked = await Effect.runPromise(first.database.registerFileBuffer('leaky.csv', new TextEncoder().encode('name\nAda\n')));
  await Effect.runPromise(first.database.run('CREATE TABLE leftover(x INTEGER)'));
  await first.close();

  const { database: second, close } = await openInScope(new SharedEngineWasmDatabase().open());
  await expect(Effect.runPromise(second.readObjects('SELECT * FROM leftover'))).rejects.toThrow();
  await expect(Effect.runPromise(second.readObjects(`SELECT * FROM read_csv('${leaked}', all_varchar = true)`)),
  ).rejects.toThrow();
  await close();
});
