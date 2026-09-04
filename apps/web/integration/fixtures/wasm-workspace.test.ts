import WebWorker from 'web-worker';
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
  const first = new SharedEngineWasmDatabase();
  const leaked = await first.registerFileBuffer(
    'leaky.csv',
    new TextEncoder().encode('name\nAda\n'),
  );
  await first.run('CREATE TABLE leftover(x INTEGER)');
  expect(await first.close()).toEqual([]);

  const second = new SharedEngineWasmDatabase();
  await expect(second.readObjects('SELECT * FROM leftover')).rejects.toThrow();
  await expect(
    second.readObjects(
      `SELECT * FROM read_csv('${leaked}', all_varchar = true)`,
    ),
  ).rejects.toThrow();
  expect(await second.close()).toEqual([]);
});
