import { Cause, Effect, Exit, Fiber } from 'effect';
import { describe, expect, it } from 'vitest';
import { DataEngineError, type WorkspaceDatabaseConnection } from '../database';
import type { EngineRow } from '../query/csv-result-normalization';
import { DuckDbComparisonExecutor, type ComparisonSource } from './duckdb-comparison-executor';

function stubConnection(
  overrides: Partial<WorkspaceDatabaseConnection> = {},
): WorkspaceDatabaseConnection {
  return {
    run: () => Promise.resolve(),
    readObjects: () => Promise.resolve([]),
    runCancellable: () => Promise.resolve(),
    readObjectsCancellable: () => Promise.resolve([]),
    cancelRunning: () => Promise.resolve(),
    close: () => Promise.resolve(),
    ...overrides,
  };
}

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
  it('awaits the interrupted query before releasing either its source or connection', async () => {
    const started = Promise.withResolvers<void>();
    const cancelled = Promise.withResolvers<void>();
    const query = Promise.withResolvers<never>();
    const released: string[] = [];
    const connection = stubConnection({
      readObjectsCancellable: () => {
        started.resolve();
        return query.promise;
      },
      cancelRunning: async () => {
        cancelled.resolve();
      },
      close: async () => {
        released.push('connection');
      },
    });
    const executor = new DuckDbComparisonExecutor({
      acquireSource: () => source(() => {
        released.push('source');
      }),
      connectWorker: () => Effect.succeed(connection),
      getOwnerConnection: async () => {
        throw new Error('Cancellation must not use the owner connection.');
      },
    });
    const fiber = Effect.runFork(Effect.scoped(Effect.gen(function* () {
      const attempt = yield* executor.openAttempt();
      yield* attempt.validateKey('source', ['id']);
    })));
    await started.promise;
    Effect.runFork(Fiber.interrupt(fiber));
    await cancelled.promise;
    expect(released).toEqual([]);
    query.reject(new Error('interrupted'));
    const exit = await Effect.runPromise(Fiber.await(fiber));
    expect(Exit.hasInterrupts(exit)).toBe(true);
    expect(released).toEqual(['source', 'connection']);
  });

  it('releases an eventual connection without starting queries when interrupted during acquisition', async () => {
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
      getOwnerConnection: async () => stubConnection(),
    });
    const fiber = Effect.runFork(Effect.scoped(Effect.gen(function* () {
      const attempt = yield* executor.openAttempt();
      yield* attempt.validateKey('source', ['id']);
    })));
    await requested.promise;
    Effect.runFork(Fiber.interrupt(fiber));
    connection.resolve(stubConnection({
      close: async () => {
        closed = true;
      },
    }));
    expect(Exit.hasInterrupts(await Effect.runPromise(Fiber.await(fiber)))).toBe(true);
    expect(closed).toBe(true);
    expect(queried).toBe(false);
  });

  it('releases the baseline and connection when candidate acquisition fails', async () => {
    const released: string[] = [];
    const connection = stubConnection({
      close: async () => {
        released.push('connection');
      },
    });
    const executor = new DuckDbComparisonExecutor({
      connectWorker: () => Effect.succeed(connection),
      getOwnerConnection: async () => connection,
      acquireSource: (id) => id === 'candidate'
        ? Effect.fail(new DataEngineError(new Error('candidate unavailable')))
        : source(() => {
          released.push('baseline');
        }),
    });
    const exit = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
      const attempt = yield* executor.openAttempt();
      yield* attempt.createSnapshot(snapshotRequest);
    })));
    if (!Exit.isFailure(exit)) throw new Error('Expected candidate acquisition to fail.');
    expect(released).toEqual(['baseline', 'connection']);
    expect(exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)).toMatchObject([
      { cause: { message: 'candidate unavailable' } },
    ]);
  });

  it.each(['throws', 'rejects'] as const)('retains query and cleanup causes when the driver %s and retries cleanup', async (failureMode) => {
    const queryFailure = new Error('query failed');
    let closeFails = true;
    let workerClosed = false;
    const connection = stubConnection({
      readObjectsCancellable: () => {
        if (failureMode === 'throws') throw queryFailure;
        return Promise.reject(queryFailure);
      },
      close: async () => {
        if (closeFails) throw new Error('close failed');
        workerClosed = true;
      },
    });
    const executor = new DuckDbComparisonExecutor({
      connectWorker: () => Effect.succeed(connection),
      getOwnerConnection: async () => connection,
      acquireSource: () => source(),
    });
    const exit = await Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
      const attempt = yield* executor.openAttempt();
      yield* attempt.validateKey('source', ['id']);
    })));
    if (!Exit.isFailure(exit)) throw new Error('Expected the query to fail.');
    expect(exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error)).toMatchObject([
      { cause: queryFailure },
    ]);
    expect(exit.cause.reasons.filter(Cause.isDieReason).map((reason) => reason.defect)).toMatchObject([
      { name: 'ComparisonCleanupError', cause: { message: 'close failed' } },
    ]);
    closeFails = false;
    await Effect.runPromise(executor.dispose());
    expect(workerClosed).toBe(true);
  });

  it('continues independent disposal after a failed worker close', async () => {
    const dropped: string[] = [];
    const owner = stubConnection({
      run: async (sql) => {
        dropped.push(sql);
      },
    });
    const worker = stubConnection({
      readObjectsCancellable: async () => summary,
      close: async () => {
        throw new Error('close failed');
      },
    });
    const executor = new DuckDbComparisonExecutor({
      connectWorker: () => Effect.succeed(worker),
      getOwnerConnection: async () => owner,
      acquireSource: () => source(),
    });
    await Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
      const attempt = yield* executor.openAttempt();
      yield* attempt.createSnapshot(snapshotRequest);
      executor.activateSnapshot('attempt');
    })));
    await expect(Effect.runPromise(executor.dispose())).rejects.toThrow('The data engine could not complete the operation.');
    expect(dropped).toHaveLength(1);
  });

  it('keeps a published snapshot until all its active readers complete', async () => {
    const readStarted = Promise.withResolvers<void>();
    const reads = [Promise.withResolvers<EngineRow[]>(), Promise.withResolvers<EngineRow[]>()];
    let readCount = 0;
    let dropped = false;
    let workerClosed = false;
    const owner = stubConnection({
      readObjects: (sql) => {
        if (sql.includes('count(*)')) {
          const read = reads[readCount++];
          if (readCount === reads.length) readStarted.resolve();
          return read.promise;
        }
        return Promise.resolve([]);
      },
      run: async () => {
        dropped = true;
      },
    });
    const executor = new DuckDbComparisonExecutor({
      connectWorker: () => Effect.succeed(stubConnection({
        readObjectsCancellable: async () => summary,
        close: async () => {
          workerClosed = true;
        },
      })),
      getOwnerConnection: async () => owner,
      acquireSource: () => source(),
    });
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const attempt = yield* executor.openAttempt();
      yield* attempt.createSnapshot(snapshotRequest);
      executor.activateSnapshot('attempt');
    })));
    expect(workerClosed).toBe(true);
    const windows = reads.map(() => Effect.runPromise(executor.readWindow({
      artifactId: 'attempt',
      keyCount: 1,
      columnIndexes: [0],
      offset: 0,
      limit: 10,
      differencesOnly: false,
      swapped: false,
    })));
    await readStarted.promise;
    const retirement = Effect.runPromise(executor.dropSnapshot('attempt'));
    expect(dropped).toBe(false);
    reads[0].resolve([{ count: 0n }]);
    await expect(windows[0]).resolves.toEqual({ totalRowCount: 0, rows: [] });
    expect(dropped).toBe(false);
    reads[1].resolve([{ count: 0n }]);
    await expect(windows[1]).resolves.toEqual({ totalRowCount: 0, rows: [] });
    await retirement;
    expect(dropped).toBe(true);
    await Effect.runPromise(executor.dispose());
  });

  it('settles a non-cancellable result read before interruption can release its snapshot', async () => {
    const readStarted = Promise.withResolvers<void>();
    const read = Promise.withResolvers<EngineRow[]>();
    let settled = false;
    let dropped = false;
    let cancellationRequested = false;
    const owner = stubConnection({
      readObjects: (sql) => {
        if (!sql.includes('count(*)')) return Promise.resolve([]);
        readStarted.resolve();
        return read.promise;
      },
      cancelRunning: async () => { cancellationRequested = true; },
      run: async () => { dropped = true; },
    });
    const executor = new DuckDbComparisonExecutor({
      connectWorker: () => Effect.succeed(stubConnection({ readObjectsCancellable: async () => summary })),
      getOwnerConnection: async () => owner,
      acquireSource: () => source(),
    });
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const attempt = yield* executor.openAttempt();
      yield* attempt.createSnapshot(snapshotRequest);
      executor.activateSnapshot('attempt');
    })));
    const reading = Effect.runFork(executor.readWindow({
      artifactId: 'attempt', keyCount: 1, columnIndexes: [0], offset: 0, limit: 10,
      differencesOnly: false, swapped: false,
    }).pipe(Effect.ensuring(Effect.sync(() => { settled = true; }))));
    await readStarted.promise;
    const interruption = Effect.runPromise(Fiber.interrupt(reading));
    const retirement = Effect.runPromise(executor.dropSnapshot('attempt'));
    try {
      await Effect.runPromise(Effect.yieldNow);
      expect(settled).toBe(false);
      expect(dropped).toBe(false);
      expect(cancellationRequested).toBe(false);
    } finally {
      read.resolve([{ count: 0n }]);
      await Promise.all([interruption, retirement]);
      await Effect.runPromise(executor.dispose());
    }
    expect(settled).toBe(true);
    expect(dropped).toBe(true);
  });
});
