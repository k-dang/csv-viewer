import { Cause, Effect, Exit, Fiber } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { DataEngineError, driverEffect, type WorkspaceDatabaseConnection } from '../database';
import type { EngineRow } from '../query/csv-result-normalization';
import { stubConnection } from '../../test/stub-connection';
import { DuckDbComparisonExecutor, type ComparisonSource } from './duckdb-comparison-executor';

const snapshotRequest = {
  artifactId: 'attempt',
  comparisonId: 'comparison',
  baselineId: 'baseline',
  candidateId: 'candidate',
  key: ['id'],
  valueColumns: ['value'],
};

/** A scoped source lease that runs `release` when the attempt scope closes. */
function source(release: () => void = () => undefined) {
  return Effect.acquireRelease(Effect.succeed<ComparisonSource>({
    tableName: 'source',
    columns: [{ name: 'id', type: 'VARCHAR' }, { name: 'value', type: 'VARCHAR' }],
  }), () => Effect.sync(release));
}

const summary = [{ changed: 0n, baseline_only: 0n, candidate_only: 0n, unchanged: 0n, total: 0n, changed_count_0: 0n }];

describe('DuckDbComparisonExecutor scoped lifecycle', () => {
  it.effect('awaits the interrupted query before releasing either its source or connection', () => Effect.gen(function* () {
    const started = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const query = Promise.withResolvers<never>();
    const released: string[] = [];
    const connection = stubConnection({
      readObjectsCancellable: () => driverEffect(() => {
        started.resolve();
        return query.promise;
      }, async () => {
        cancelled.resolve();
      }),
      close: () => Effect.sync(() => {
        released.push('connection');
      }),
    });
    const executor = new DuckDbComparisonExecutor({
      acquireSource: () => source(() => {
        released.push('source');
      }),
      connectWorker: () => Effect.succeed(connection),
      getOwnerConnection: () => Effect.die(new Error('Cancellation must not use the owner connection.')),
    });
    const fiber = yield* Effect.forkScoped(Effect.scoped(Effect.gen(function* () {
      const attempt = yield* executor.openAttempt();
      yield* attempt.validateKey('source', ['id']);
    })));
    yield* Effect.promise(() => started.promise);
    yield* Effect.forkScoped(Fiber.interrupt(fiber), { startImmediately: true });
    yield* Effect.addFinalizer(() => Effect.sync(() => query.reject(new Error('Test finished.'))));
    yield* Effect.promise(() => cancelled.promise);
    expect(released).toEqual([]);
    query.reject(new Error('interrupted'));
    const exit = yield* Fiber.await(fiber);
    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(released).toEqual(['source', 'connection']);
  }));

  it.effect('fails an unknown key column as a request failure, not a defect, and releases the source', () => Effect.gen(function* () {
    const released: string[] = [];
    let queried = false;
    const executor = new DuckDbComparisonExecutor({
      acquireSource: () => source(() => {
        released.push('source');
      }),
      connectWorker: () => Effect.succeed(stubConnection({
        readObjectsCancellable: () => Effect.sync(() => {
          queried = true;
          return [];
        }),
        close: () => Effect.sync(() => {
          released.push('connection');
        }),
      })),
      getOwnerConnection: () => Effect.succeed(stubConnection()),
    });
    const exit = yield* Effect.exit(Effect.scoped(Effect.gen(function* () {
      const attempt = yield* executor.openAttempt();
      yield* attempt.validateKey('source', ['id', 'missing']);
    })));
    expect(Exit.isFailure(exit) && Cause.hasDies(exit.cause)).toBe(false);
    expect(Exit.isFailure(exit) && exit.cause.reasons.map((reason) => reason._tag === 'Fail' && reason.error.message))
      .toEqual(['Unknown CSV column: missing']);
    expect(queried).toBe(false);
    expect(released).toEqual(['source', 'connection']);
  }));

  it.effect('releases an eventual connection without starting queries when interrupted during acquisition', () => Effect.gen(function* () {
    const requested = Promise.withResolvers<void>();
    const connection = Promise.withResolvers<WorkspaceDatabaseConnection>();
    let closed = false;
    let queried = false;
    const executor = new DuckDbComparisonExecutor({
      connectWorker: () => Effect.promise(() => {
        requested.resolve();
        return connection.promise;
      }),
      acquireSource: () => Effect.suspend(() => {
        queried = true;
        return source();
      }),
      getOwnerConnection: () => Effect.succeed(stubConnection()),
    });
    const fiber = yield* Effect.forkScoped(Effect.scoped(Effect.gen(function* () {
      const attempt = yield* executor.openAttempt();
      yield* attempt.validateKey('source', ['id']);
    })));
    yield* Effect.promise(() => requested.promise);
    yield* Effect.forkScoped(Fiber.interrupt(fiber), { startImmediately: true });
    yield* Effect.addFinalizer(() => Effect.sync(() => connection.resolve(stubConnection())));
    connection.resolve(stubConnection({
      close: () => Effect.sync(() => {
        closed = true;
      }),
    }));
    expect(Exit.hasInterrupts(yield* Fiber.await(fiber))).toBe(true);
    expect(closed).toBe(true);
    expect(queried).toBe(false);
  }));

  it.effect('releases the baseline and connection when candidate acquisition fails', () => Effect.gen(function* () {
    const released: string[] = [];
    const connection = stubConnection({
      close: () => Effect.sync(() => {
        released.push('connection');
      }),
    });
    const executor = new DuckDbComparisonExecutor({
      connectWorker: () => Effect.succeed(connection),
      getOwnerConnection: () => Effect.succeed(connection),
      acquireSource: (id) => id === 'candidate'
        ? Effect.fail(new DataEngineError({ cause: new Error('candidate unavailable') }))
        : source(() => {
          released.push('baseline');
        }),
    });
    const exit = yield* Effect.exit(Effect.scoped(Effect.gen(function* () {
      const attempt = yield* executor.openAttempt();
      yield* attempt.createSnapshot(snapshotRequest);
    })));
    if (!Exit.isFailure(exit)) throw new Error('Expected candidate acquisition to fail.');
    expect(released).toEqual(['baseline', 'connection']);
    expect(exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)).toMatchObject([
      { cause: { message: 'candidate unavailable' } },
    ]);
  }));

  it.effect('retains typed query and cleanup causes and retries cleanup', () => Effect.gen(function* () {
    const queryFailure = new Error('query failed');
    let closeFails = true;
    let workerClosed = false;
    const connection = stubConnection({
      readObjectsCancellable: () => Effect.fail(new DataEngineError({ cause: queryFailure })),
      close: () => Effect.suspend(() => closeFails
        ? Effect.fail(new DataEngineError({ cause: new Error('close failed') }))
        : Effect.sync(() => { workerClosed = true; })),
    });
    const executor = new DuckDbComparisonExecutor({
      connectWorker: () => Effect.succeed(connection),
      getOwnerConnection: () => Effect.succeed(connection),
      acquireSource: () => source(),
    });
    const exit = yield* Effect.exit(Effect.scoped(Effect.gen(function* () {
      const attempt = yield* executor.openAttempt();
      yield* attempt.validateKey('source', ['id']);
    })));
    if (!Exit.isFailure(exit)) throw new Error('Expected the query to fail.');
    expect(exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)).toMatchObject([
      { cause: queryFailure },
    ]);
    expect(exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect)).toMatchObject([
      { name: 'ComparisonCleanupError', cause: { name: 'DataEngineError', cause: { message: 'close failed' } } },
    ]);
    closeFails = false;
    yield* executor.dispose();
    expect(workerClosed).toBe(true);
  }));

  it.effect('continues independent disposal after a failed worker close', () => Effect.gen(function* () {
    const dropped: string[] = [];
    const owner = stubConnection({
      run: (sql) => Effect.sync(() => {
        dropped.push(sql);
      }),
    });
    const worker = stubConnection({
      readObjectsCancellable: () => Effect.succeed(summary),
      close: () => Effect.fail(new DataEngineError({ cause: new Error('close failed') })),
    });
    const executor = new DuckDbComparisonExecutor({
      connectWorker: () => Effect.succeed(worker),
      getOwnerConnection: () => Effect.succeed(owner),
      acquireSource: () => source(),
    });
    yield* Effect.exit(Effect.scoped(Effect.gen(function* () {
      const attempt = yield* executor.openAttempt();
      yield* attempt.createSnapshot(snapshotRequest);
      executor.activateSnapshot('attempt');
    })));
    const disposed = yield* Effect.exit(executor.dispose());
    expect(Exit.isFailure(disposed) && Cause.squash(disposed.cause)).toMatchObject({ message: 'The data engine could not complete the operation.' });
    expect(dropped).toHaveLength(1);
  }));

  it.effect('keeps a published snapshot until all its active readers complete', () => Effect.gen(function* () {
    const readStarted = Promise.withResolvers<void>();
    const reads = [Promise.withResolvers<EngineRow[]>(), Promise.withResolvers<EngineRow[]>()];
    let readCount = 0;
    let dropped = false;
    let workerClosed = false;
    const owner = stubConnection({
      readObjects: (sql) => Effect.suspend(() => {
        if (sql.includes('count(*)')) {
          const read = reads[readCount++];
          if (readCount === reads.length) readStarted.resolve();
          return Effect.promise(() => read.promise);
        }
        return Effect.succeed([]);
      }),
      run: () => Effect.sync(() => {
        dropped = true;
      }),
    });
    const executor = new DuckDbComparisonExecutor({
      connectWorker: () => Effect.succeed(stubConnection({
        readObjectsCancellable: () => Effect.succeed(summary),
        close: () => Effect.sync(() => {
          workerClosed = true;
        }),
      })),
      getOwnerConnection: () => Effect.succeed(owner),
      acquireSource: () => source(),
    });
    yield* Effect.scoped(Effect.gen(function* () {
      const attempt = yield* executor.openAttempt();
      yield* attempt.createSnapshot(snapshotRequest);
      executor.activateSnapshot('attempt');
    }));
    expect(workerClosed).toBe(true);
    const windows = yield* Effect.forEach(reads, () => Effect.forkScoped(executor.readWindow({
      artifactId: 'attempt',
      keyCount: 1,
      valueCount: 1,
      offset: 0,
      limit: 10,
      rows: 'all', search: '', order: 'csv-order',
      swapped: false,
    })));
    yield* Effect.promise(() => readStarted.promise);
    const retirement = yield* Effect.forkScoped(executor.dropSnapshot('attempt'), { startImmediately: true });
    yield* Effect.addFinalizer(() => Effect.sync(() => reads.forEach((read) => read.resolve([{ count: 0n }]))));
    expect(dropped).toBe(false);
    reads[0].resolve([{ count: 0n }]);
    expect(yield* Fiber.join(windows[0])).toEqual({ totalRowCount: 0, rows: [] });
    expect(dropped).toBe(false);
    reads[1].resolve([{ count: 0n }]);
    expect(yield* Fiber.join(windows[1])).toEqual({ totalRowCount: 0, rows: [] });
    yield* Fiber.join(retirement);
    expect(dropped).toBe(true);
    yield* executor.dispose();
  }));

  it.effect('settles a non-cancellable result read before interruption can release its snapshot', () => Effect.gen(function* () {
    const readStarted = Promise.withResolvers<void>();
    const read = Promise.withResolvers<EngineRow[]>();
    let settled = false;
    let dropped = false;
    const owner = stubConnection({
      readObjects: (sql) => Effect.suspend(() => {
        if (!sql.includes('count(*)')) return Effect.succeed([]);
        readStarted.resolve();
        return Effect.promise(() => read.promise);
      }),
      run: () => Effect.sync(() => { dropped = true; }),
    });
    const executor = new DuckDbComparisonExecutor({
      connectWorker: () => Effect.succeed(stubConnection({ readObjectsCancellable: () => Effect.succeed(summary) })),
      getOwnerConnection: () => Effect.succeed(owner),
      acquireSource: () => source(),
    });
    yield* Effect.scoped(Effect.gen(function* () {
      const attempt = yield* executor.openAttempt();
      yield* attempt.createSnapshot(snapshotRequest);
      executor.activateSnapshot('attempt');
    }));
    const reading = yield* Effect.forkScoped(executor.readWindow({
      artifactId: 'attempt', keyCount: 1, valueCount: 1, offset: 0, limit: 10,
      rows: 'all', search: '', order: 'csv-order', swapped: false,
    }).pipe(Effect.ensuring(Effect.sync(() => { settled = true; }))));
    yield* Effect.promise(() => readStarted.promise);
    const interruption = yield* Effect.forkScoped(Fiber.interrupt(reading), { startImmediately: true });
    const retirement = yield* Effect.forkScoped(executor.dropSnapshot('attempt'), { startImmediately: true });
    yield* Effect.addFinalizer(() => Effect.sync(() => read.resolve([{ count: 0n }])));
    expect(settled).toBe(false);
    expect(dropped).toBe(false);
    read.resolve([{ count: 0n }]);
    yield* Fiber.join(interruption);
    yield* Fiber.join(retirement);
    yield* executor.dispose();
    expect(settled).toBe(true);
    expect(dropped).toBe(true);
  }));
});
