import { AsyncDuckDBConnection } from '@duckdb/duckdb-wasm';
import { stoppedEngineMessage } from '@csv-viewer/workspace/database';
import { Deferred, Effect, Fiber } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createNodeDuckDbWasmDatabase, nodeWasmOptions } from '../integration/fixtures/wasm-workspace';
import { ControllableWorker } from '../integration/fixtures/controllable-worker';
import { describeDatabaseInterruption, driverMethod } from '../../../packages/workspace/test/contract/database-interruption.contract';
import { DuckDbWasmWorkspaceDatabase } from './duckdb-wasm-database';

describeDatabaseInterruption('DuckDbWasmWorkspaceDatabase interruption', {
  open: () => Effect.runPromise(createNodeDuckDbWasmDatabase().open()),
  cancellableStart: driverMethod(AsyncDuckDBConnection.prototype, 'send'),
  cancellableExecution: driverMethod(AsyncDuckDBConnection.prototype, 'send'),
  read: driverMethod(AsyncDuckDBConnection.prototype, 'query'),
});

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

/** Opens a real engine and returns a way to fail its Worker the way the browser reports a crash. */
async function openCrashableDatabase() {
  let worker: EventTarget | undefined;
  const opened = new DuckDbWasmWorkspaceDatabase({
    ...nodeWasmOptions,
    createWorker: async (reference) => (worker = await nodeWasmOptions.createWorker(reference)),
  });
  database = await Effect.runPromise(opened.open());
  return {
    database: opened,
    crash: () => {
      if (!worker) throw new Error('The engine did not create its Worker.');
      // SAFETY: web-worker's Node EventTarget dispatches plain objects, as it does for its own errors.
      worker.dispatchEvent({ type: 'error', error: new Error('Worker crashed.') } as never);
    },
  };
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

  it('fails a query in flight when the Worker fails instead of waiting forever', async () => {
    const engine = await openCrashableDatabase();
    const started = driverMethod(AsyncDuckDBConnection.prototype, 'query').observe();
    const work = Effect.runFork(Effect.flip(engine.database.readObjectsEffect(
      'SELECT sum(a.range * b.range) AS total FROM range(1000000) a, range(1000000) b',
    )));
    await started;

    engine.crash();

    await expect(Effect.runPromise(Fiber.join(work))).resolves.toMatchObject({
      name: 'DataEngineError',
      cause: { message: stoppedEngineMessage },
    });
  }, 15_000);

  it('finishes an owner connection release that the Worker failure leaves unanswered', async () => {
    const engine = await openCrashableDatabase();
    const closing = Promise.withResolvers<void>();
    vi.spyOn(AsyncDuckDBConnection.prototype, 'close').mockImplementation(() => {
      closing.resolve();
      return new Promise<void>(() => undefined);
    });
    const release = Effect.runFork(Effect.flip(engine.database.closeOwnerConnection()));
    await closing.promise;

    engine.crash();

    await expect(Effect.runPromise(Fiber.join(release))).resolves.toMatchObject({
      cause: { message: stoppedEngineMessage },
    });
  });

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
