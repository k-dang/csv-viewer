import { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { stoppedEngineMessage } from '@csv-viewer/workspace/database';
import { Cause, Deferred, Effect, Exit, Fiber } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeDuckDbWasmDatabase, nodeWasmOptions } from '../integration/fixtures/wasm-workspace';
import { ControllableWorker } from '../integration/fixtures/controllable-worker';
import { holdDriverSettlement, observeDriverCall, observeInterruption } from '../../../packages/workspace/test/driver-settlement';
import { DuckDbWasmWorkspaceDatabase } from './duckdb-wasm-database';

const longQuery = 'SELECT sum(a.range * b.range) AS total FROM range(1000000) a, range(1000000) b';

let database: DuckDbWasmWorkspaceDatabase | undefined;

afterEach(async () => {
  vi.restoreAllMocks();
  if (database) {
    await Effect.runPromise(database.closeOwnerConnection());
    await Effect.runPromise(database.closeEngine());
  }
  database = undefined;
});

function openNodeDatabase(): Promise<DuckDbWasmWorkspaceDatabase> {
  return Effect.runPromise(createNodeDuckDbWasmDatabase().open());
}

describe('DuckDbWasmWorkspaceDatabase', () => {
  it('runs parameterized queries on the pinned in-memory DuckDB core', async () => {
    database = await openNodeDatabase();

    const rows = await database.readObjects(
      'SELECT version() AS version, ?::VARCHAR AS text, ?::BOOLEAN AS enabled, ?::INTEGER AS count',
      ['local', true, 3],
    );

    expect(rows).toEqual([
      {
        version: 'v1.5.5',
        text: 'local',
        enabled: true,
        count: 3,
      },
    ]);
  });

  it('reads registered memory files while rejecting remote sources and extension fetching', async () => {
    database = await openNodeDatabase();
    const reference = await database.registerFileBuffer(
      'people.csv',
      new TextEncoder().encode('name,age\nAda,37\n'),
    );

    const rows = await database.readObjects(
      `SELECT * FROM read_csv_auto('${reference}', all_varchar = true)`,
    );

    expect(rows).toEqual([{ name: 'Ada', age: '37' }]);
    await expect(
      database.readObjects(
        "SELECT current_setting('enable_external_access') AS external_access, current_setting('autoinstall_known_extensions') AS autoinstall, current_setting('autoload_known_extensions') AS autoload",
      ),
    ).resolves.toEqual([{ external_access: false, autoinstall: false, autoload: false }]);
    for (const sql of [
      "SELECT * FROM read_csv_auto('https://example.invalid/source.csv')",
      'LOAD spatial',
      'SET enable_external_access = true',
      'SET autoinstall_known_extensions = true',
      'SET autoload_known_extensions = true',
    ]) {
      const outcome = await database.run(sql).then(() => 'allowed', () => 'rejected');
      expect(outcome, sql).toBe('rejected');
    }
    await expect(database.readObjects('SELECT 42 AS answer')).resolves.toEqual([{ answer: 42 }]);
  });

  it('rejects runtime CDN module URLs', () => {
    expect(
      () =>
        new DuckDbWasmWorkspaceDatabase({
          mainModule: 'https://cdn.example.com/duckdb.wasm',
          mainWorker: 'duckdb.worker.js',
          createWorker: () => Promise.reject(new Error('not used')),
        }),
    ).toThrow('self-hosted');

    expect(
      () =>
        new DuckDbWasmWorkspaceDatabase({
          mainModule: 'duckdb.wasm',
          mainWorker: 'https://cdn.example.com/duckdb.worker.js',
          createWorker: () => Promise.reject(new Error('not used')),
        }),
    ).toThrow('self-hosted');
  });

  it('rejects protocol-relative executable asset URLs', () => {
    expect(
      () =>
        new DuckDbWasmWorkspaceDatabase({
          mainModule: '//cdn.example.com/duckdb.wasm',
          mainWorker: 'duckdb.worker.js',
          createWorker: () => Promise.reject(new Error('not used')),
        }),
    ).toThrow('self-hosted');

    expect(
      () =>
        new DuckDbWasmWorkspaceDatabase({
          mainModule: 'duckdb.wasm',
          mainWorker: '//cdn.example.com/duckdb.worker.js',
          createWorker: () => Promise.reject(new Error('not used')),
        }),
    ).toThrow('self-hosted');
  });

  it('fails driver errors as a sanitized DataEngineError', async () => {
    database = await openNodeDatabase();

    const exit = await Effect.runPromiseExit(database.readObjectsEffect('SELECT * FROM missing_table'));

    if (!Exit.isFailure(exit)) throw new Error('Expected the query to fail.');
    expect(Cause.hasDies(exit.cause)).toBe(false);
    const [failure] = exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error);
    expect(failure).toMatchObject({
      name: 'DataEngineError',
      message: 'The data engine could not complete the operation.',
    });
    expect(failure.message).not.toContain('missing_table');
  });

  it('cancels long work interrupted as the driver starts it', async () => {
    database = await openNodeDatabase();
    const worker = await Effect.runPromise(database.connectWorkerEffect());
    const started = observeDriverCall(AsyncDuckDBConnection.prototype, 'send');
    const work = Effect.runFork(worker.runCancellableEffect(`CREATE TABLE cancelled_work AS ${longQuery}`));
    await started;

    await observeInterruption(work).done;

    expect(Exit.hasInterrupts(await Effect.runPromise(Fiber.await(work)))).toBe(true);
    await expect(Effect.runPromise(database.readObjectsEffect(
      "SELECT count(*)::BIGINT AS count FROM information_schema.tables WHERE table_name = 'cancelled_work'",
    ))).resolves.toEqual([{ count: 0n }]);
    await expect(Effect.runPromise(worker.readObjectsEffect('SELECT 42 AS answer'))).resolves.toEqual([{ answer: 42 }]);
    await Effect.runPromise(worker.closeEffect());
  }, 15_000);

  it('waits for cancelled driver work to settle before interruption completes', async () => {
    database = await openNodeDatabase();
    const execution = holdDriverSettlement(AsyncDuckDBConnection.prototype, 'send');
    const worker = await Effect.runPromise(database.connectWorkerEffect());
    const work = Effect.runFork(worker.readObjectsCancellableEffect(longQuery));
    await execution.entered;

    const interruption = observeInterruption(work);
    await vi.waitFor(() => expect(execution.settled).toHaveBeenCalled(), { timeout: 10_000 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(interruption.state.completed).toBe(false);

    execution.release();
    await interruption.done;
    expect(Exit.hasInterrupts(await Effect.runPromise(Fiber.await(work)))).toBe(true);
    await expect(Effect.runPromise(worker.readObjectsEffect('SELECT 42 AS answer'))).resolves.toEqual([{ answer: 42 }]);
    await Effect.runPromise(worker.closeEffect());
  }, 15_000);

  it('completes interruption of non-cancellable work only after the driver settles', async () => {
    database = await openNodeDatabase();
    const query = holdDriverSettlement(AsyncDuckDBConnection.prototype, 'query');
    const work = Effect.runFork(database.readObjectsEffect('SELECT 42 AS answer'));
    await query.entered;

    const interruption = observeInterruption(work);
    await vi.waitFor(() => expect(query.settled).toHaveBeenCalled());
    await new Promise((resolve) => setImmediate(resolve));
    expect(interruption.state.completed).toBe(false);

    query.release();
    await interruption.done;
    expect(Exit.hasInterrupts(await Effect.runPromise(Fiber.await(work)))).toBe(true);
  });

  it('settles a query in flight when the Worker fails, so its interruption completes', async () => {
    let worker: EventTarget | undefined;
    database = new DuckDbWasmWorkspaceDatabase({
      ...nodeWasmOptions,
      createWorker: async (reference) => (worker = await nodeWasmOptions.createWorker(reference)),
    });
    await Effect.runPromise(database.open());
    const started = observeDriverCall(AsyncDuckDBConnection.prototype, 'query');
    const work = Effect.runFork(database.readObjectsEffect(longQuery));
    await started;

    // SAFETY: web-worker's Node EventTarget dispatches plain objects, as it does for its own errors.
    worker?.dispatchEvent({ type: 'error', error: new Error('Worker crashed.') } as never);
    await observeInterruption(work).done;

    const exit = await Effect.runPromise(Fiber.await(work));
    expect(Exit.isFailure(exit) && exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error))
      .toMatchObject([{ name: 'DataEngineError', cause: { message: stoppedEngineMessage } }]);
  }, 15_000);

  it.each(['pending request', 'pending creation'])('cancels startup during %s and terminates the Worker once', async (phase) => {
    const worker = new ControllableWorker();
    const creation = Promise.withResolvers<Worker>();
    database = new DuckDbWasmWorkspaceDatabase({
      mainModule: 'duckdb.wasm', mainWorker: 'duckdb.worker.js',
      createWorker: () => phase === 'pending creation' ? creation.promise : Promise.resolve(worker),
    });
    const opening = Effect.runFork(database.open());
    if (phase === 'pending request') await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled());
    await Effect.runPromise(Fiber.interrupt(opening));
    await expect(Effect.runPromise(database.closeEngine())).resolves.toBeUndefined();
    if (phase === 'pending creation') creation.resolve(worker);
    await vi.waitFor(() => expect(worker.terminate).toHaveBeenCalledOnce());
    await expect(Effect.runPromise(database.ownerConnectionEffect())).rejects.toMatchObject({
      name: 'DataEngineError',
      cause: { message: stoppedEngineMessage },
    });
  });

  it('reports a Worker crash once and refuses to restart the engine', async () => {
    const worker = new ControllableWorker();
    database = new DuckDbWasmWorkspaceDatabase({
      mainModule: 'duckdb.wasm',
      mainWorker: 'duckdb.worker.js',
      createWorker: () => Promise.resolve(worker),
    });
    Effect.runFork(database.open());
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled());

    worker.emitError(new Error('Worker crashed.'));
    worker.emitError(new Error('Worker crashed again.'));

    expect(Deferred.isDoneUnsafe(database.stopped)).toBe(true);
    expect(worker.terminate).toHaveBeenCalledOnce();
    await expect(Effect.runPromise(database.readObjectsEffect('SELECT 1'))).rejects.toMatchObject({
      name: 'DataEngineError',
      cause: { message: stoppedEngineMessage },
    });
  });

  it('holds a failed Worker termination after a crash for the engine release', async () => {
    const worker = new ControllableWorker();
    worker.terminate.mockImplementation(() => {
      throw new Error('Worker termination failed.');
    });
    const crashed = new DuckDbWasmWorkspaceDatabase({
      mainModule: 'duckdb.wasm',
      mainWorker: 'duckdb.worker.js',
      createWorker: () => Promise.resolve(worker),
    });
    Effect.runFork(crashed.open());
    await vi.waitFor(() => expect(worker.postMessage).toHaveBeenCalled());

    worker.emitError(new Error('Worker crashed.'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(Effect.runPromise(crashed.closeEngine())).rejects.toMatchObject({
      name: 'DataEngineError',
      cause: { message: 'Worker termination failed.' },
    });
  });
});
