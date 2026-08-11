import { describe, expect, it } from 'vitest';
import type { DuckDBConnection } from '@duckdb/node-api';
import { DuckDbComparisonExecutor } from './duckdb-comparison-executor';

type Deferred<T> = {
  promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(error: Error): void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: Deferred<T>['resolve'];
  let reject!: Deferred<T>['reject'];
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('DuckDbComparisonExecutor worker lifecycle', () => {
  it('interrupts an active operation before releasing its dedicated connection', async () => {
    let interrupted = false;
    let closed = false;
    const queryStarted = createDeferred<void>();
    const query = createDeferred<never>();
    const connection = {
      runAndReadAll: () => {
        queryStarted.resolve();
        return query.promise;
      },
      interrupt: () => {
        interrupted = true;
        query.reject(new Error('interrupted'));
      },
      closeSync: () => {
        closed = true;
      },
    } as unknown as DuckDBConnection;
    const executor = new DuckDbComparisonExecutor({
      acquireSource: async () => ({
        tableName: 'source',
        columns: [{ name: 'id', type: 'VARCHAR' }],
        release: async () => undefined,
      }),
      getOwnerConnection: async () => connection,
      connectWorker: async () => connection,
    });

    const validation = executor.validateKey('operation', 'source', ['id']);
    await queryStarted.promise;
    executor.cancel('operation');

    await expect(validation).rejects.toThrow('interrupted');
    expect(interrupted).toBe(true);
    expect(closed).toBe(false);
    await executor.release('operation');
    expect(closed).toBe(true);
  });

  it('releases a worker when cancellation wins the connection race', async () => {
    let closed = false;
    const connectionRequested = createDeferred<void>();
    const workerConnection = createDeferred<DuckDBConnection>();
    const connection = {
      interrupt: () => undefined,
      closeSync: () => {
        closed = true;
      },
    } as unknown as DuckDBConnection;
    const executor = new DuckDbComparisonExecutor({
      acquireSource: async () => ({
        tableName: 'source',
        columns: [{ name: 'id', type: 'VARCHAR' }],
        release: async () => undefined,
      }),
      getOwnerConnection: async () => connection,
      connectWorker: () => {
        connectionRequested.resolve();
        return workerConnection.promise;
      },
    });

    const validation = executor.validateKey('operation', 'source', ['id']);
    await connectionRequested.promise;
    executor.cancel('operation');
    workerConnection.resolve(connection);

    await expect(validation).rejects.toThrow('cancelled');
    await executor.release('operation');
    expect(closed).toBe(true);
  });

  it('does not reuse a cancelled worker for the next validation phase', async () => {
    let queryCount = 0;
    const connection = {
      runAndReadAll: (sql: string) => {
        queryCount += 1;
        return Promise.resolve({
          getRowObjectsJS: () =>
            sql.includes('AS count') ? [{ count: 0n }] : [],
        });
      },
      interrupt: () => undefined,
      closeSync: () => undefined,
    } as unknown as DuckDBConnection;
    const executor = new DuckDbComparisonExecutor({
      acquireSource: async () => ({
        tableName: 'source',
        columns: [{ name: 'id', type: 'VARCHAR' }],
        release: async () => undefined,
      }),
      getOwnerConnection: async () => connection,
      connectWorker: async () => connection,
    });

    await expect(executor.validateKey('operation', 'baseline', ['id'])).resolves.toMatchObject({
      blankRowCount: 0,
      duplicateGroupCount: 0,
    });
    executor.cancel('operation');

    await expect(executor.validateKey('operation', 'candidate', ['id'])).rejects.toThrow(
      'cancelled',
    );
    expect(queryCount).toBe(4);
    await executor.release('operation');
  });

  it('unregisters a worker even when closing its connection fails', async () => {
    let closeAttempts = 0;
    const connection = {
      runAndReadAll: (sql: string) =>
        Promise.resolve({
          getRowObjectsJS: () => (sql.includes('AS count') ? [{ count: 0n }] : []),
        }),
      closeSync: () => {
        closeAttempts += 1;
        throw new Error('close failed');
      },
    } as unknown as DuckDBConnection;
    const executor = new DuckDbComparisonExecutor({
      acquireSource: async () => ({
        tableName: 'source',
        columns: [{ name: 'id', type: 'VARCHAR' }],
        release: async () => undefined,
      }),
      getOwnerConnection: async () => connection,
      connectWorker: async () => connection,
    });

    await executor.validateKey('operation', 'source', ['id']);
    await expect(executor.release('operation')).rejects.toThrow('close failed');
    await expect(executor.release('operation')).resolves.toBeUndefined();
    expect(closeAttempts).toBe(1);
  });

  it('continues disposal after a worker release fails', async () => {
    const droppedTables: string[] = [];
    let workerIndex = 0;
    let secondWorkerClosed = false;
    const summaryResult = {
      getRowObjectsJS: () => [
        {
          changed: 0n,
          baseline_only: 0n,
          candidate_only: 0n,
          unchanged: 0n,
          total: 0n,
          changed_count_0: 0n,
        },
      ],
    };
    const workers = [
      {
        run: () => Promise.resolve(),
        runAndReadAll: () => Promise.resolve(summaryResult),
        interrupt: () => undefined,
        closeSync: () => {
          throw new Error('first close failed');
        },
      },
      {
        run: () => Promise.resolve(),
        runAndReadAll: () => Promise.resolve(summaryResult),
        interrupt: () => undefined,
        closeSync: () => {
          secondWorkerClosed = true;
        },
      },
    ] as unknown as DuckDBConnection[];
    const owner = {
      run: (sql: string) => {
        droppedTables.push(sql);
        return Promise.resolve();
      },
    } as unknown as DuckDBConnection;
    const executor = new DuckDbComparisonExecutor({
      acquireSource: async (sessionId) => ({
        tableName: sessionId,
        columns: [
          { name: 'id', type: 'VARCHAR' },
          { name: 'value', type: 'VARCHAR' },
        ],
        release: async () => undefined,
      }),
      getOwnerConnection: async () => owner,
      connectWorker: async () => workers[workerIndex++],
    });

    for (const artifactId of ['first', 'second']) {
      await executor.createSnapshot({
        artifactId,
        baselineId: 'baseline',
        candidateId: 'candidate',
        key: ['id'],
        valueColumns: ['value'],
      });
    }

    await expect(executor.dispose()).rejects.toThrow(
      'Unable to dispose all Comparison executor resources',
    );
    expect(secondWorkerClosed).toBe(true);
    expect(droppedTables).toHaveLength(2);
  });

});
