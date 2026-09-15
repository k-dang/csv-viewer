import { Cause, Effect, Exit, Fiber } from 'effect';
import { describe, expect, it } from 'vitest';
import type { WorkspaceDatabaseConnection } from '../database';
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

function source(release = async () => undefined): ComparisonSource {
  return {
    tableName: 'source',
    columns: [{ name: 'id', type: 'VARCHAR' }, { name: 'value', type: 'VARCHAR' }],
    release,
  };
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
      acquireSource: async () => source(async () => {
        released.push('source');
      }),
      connectWorker: async () => connection,
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
      connectWorker: () => {
        requested.resolve();
        return connection.promise;
      },
      acquireSource: async () => {
        queried = true;
        return source();
      },
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
      connectWorker: async () => connection,
      getOwnerConnection: async () => connection,
      acquireSource: async (id) => {
        if (id === 'candidate') throw new Error('candidate unavailable');
        return source(async () => {
          released.push('baseline');
        });
      },
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
    let releaseFails = true;
    let closeFails = true;
    let sourceReleased = false;
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
      connectWorker: async () => connection,
      getOwnerConnection: async () => connection,
      acquireSource: async () => source(async () => {
        if (releaseFails) throw new Error('lease release failed');
        sourceReleased = true;
      }),
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
      { name: 'ComparisonCleanupError', cause: { message: 'lease release failed' } },
      { name: 'ComparisonCleanupError', cause: { message: 'close failed' } },
    ]);
    releaseFails = false;
    closeFails = false;
    await executor.dispose();
    expect(sourceReleased).toBe(true);
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
      connectWorker: async () => worker,
      getOwnerConnection: async () => owner,
      acquireSource: async () => source(),
    });
    await Effect.runPromiseExit(Effect.scoped(Effect.gen(function* () {
      const attempt = yield* executor.openAttempt();
      yield* attempt.createSnapshot(snapshotRequest);
      executor.activateSnapshot('attempt');
    })));
    await expect(executor.dispose()).rejects.toThrow('Unable to dispose all Comparison executor resources');
    expect(dropped).toHaveLength(1);
  });

  it('keeps a published snapshot until its active reader completes', async () => {
    const readStarted = Promise.withResolvers<void>();
    const read = Promise.withResolvers<EngineRow[]>();
    let dropped = false;
    let workerClosed = false;
    const owner = stubConnection({
      readObjects: (sql) => {
        if (sql.includes('count(*)')) {
          readStarted.resolve();
          return read.promise;
        }
        return Promise.resolve([]);
      },
      run: async () => {
        dropped = true;
      },
    });
    const executor = new DuckDbComparisonExecutor({
      connectWorker: async () => stubConnection({
        readObjectsCancellable: async () => summary,
        close: async () => {
          workerClosed = true;
        },
      }),
      getOwnerConnection: async () => owner,
      acquireSource: async () => source(),
    });
    await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
      const attempt = yield* executor.openAttempt();
      yield* attempt.createSnapshot(snapshotRequest);
      executor.activateSnapshot('attempt');
    })));
    expect(workerClosed).toBe(true);
    const window = executor.readWindow({
      artifactId: 'attempt',
      keyCount: 1,
      columnIndexes: [0],
      offset: 0,
      limit: 10,
      differencesOnly: false,
      swapped: false,
    });
    await readStarted.promise;
    const retirement = executor.dropSnapshot('attempt');
    expect(dropped).toBe(false);
    read.resolve([{ count: 0n }]);
    await expect(window).resolves.toEqual({ totalRowCount: 0, rows: [] });
    await retirement;
    expect(dropped).toBe(true);
    await executor.dispose();
  });
});
