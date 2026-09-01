import WebWorker from 'web-worker';
import { expect, it, vi } from 'vitest';
import { WasmWorkspaceFixture } from './wasm-workspace';

it('waits for the DuckDB-Wasm worker thread to exit before completing disposal', async () => {
  const fixture = await WasmWorkspaceFixture.create();
  await fixture.openSource('worker-lifecycle.csv', ['name', 'Ada'].join('\n'));

  const releaseTermination = Promise.withResolvers<void>();
  const terminateWorker = WebWorker.prototype.terminate;
  const terminate = vi
    .spyOn(WebWorker.prototype, 'terminate')
    .mockImplementation(function (this: InstanceType<typeof WebWorker>) {
      void releaseTermination.promise.then(() => terminateWorker.call(this));
    });
  let disposed = false;
  const disposal = fixture.dispose().then(() => {
    disposed = true;
  });

  try {
    await vi.waitFor(() => expect(terminate).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(disposed).toBe(false);
  } finally {
    releaseTermination.resolve();
    await disposal;
    terminate.mockRestore();
  }
});
