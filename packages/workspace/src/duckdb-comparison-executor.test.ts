import { describe, expect, it } from 'vitest';
import type { WorkspaceDatabaseConnection } from './database';
import { DuckDbComparisonExecutor } from './duckdb-comparison-executor';

/** A connection whose unexercised operations succeed silently, so each test states only what it drives. */
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

describe('DuckDbComparisonExecutor worker lifecycle', () => {
  it('interrupts an active operation before releasing its dedicated connection', async () => {
    let interrupted = false;
    let closed = false;
    const queryStarted = Promise.withResolvers<void>();
    const query = Promise.withResolvers<never>();
    const connection = stubConnection({
      readObjectsCancellable: () => {
        queryStarted.resolve();
        return query.promise;
      },
      cancelRunning: async () => {
        interrupted = true;
        query.reject(new Error('interrupted'));
      },
      close: async () => {
        closed = true;
      },
    });
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
    const connectionRequested = Promise.withResolvers<void>();
    const workerConnection = Promise.withResolvers<WorkspaceDatabaseConnection>();
    const connection = stubConnection({
      readObjectsCancellable: () => Promise.reject(new Error('cancelled before query')),
      close: async () => {
        closed = true;
      },
    });
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
    const connection = stubConnection({
      readObjectsCancellable: (sql: string) => {
        queryCount += 1;
        return Promise.resolve(sql.includes('AS count') ? [{ count: 0n }] : []);
      },
    });
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
    const connection = stubConnection({
      readObjectsCancellable: (sql: string) =>
        Promise.resolve(sql.includes('AS count') ? [{ count: 0n }] : []),
      close: async () => {
        closeAttempts += 1;
        throw new Error('close failed');
      },
    });
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
    const summaryRows = [
      {
        changed: 0n,
        baseline_only: 0n,
        candidate_only: 0n,
        unchanged: 0n,
        total: 0n,
        changed_count_0: 0n,
      },
    ];
    const workers = [
      stubConnection({
        readObjectsCancellable: () => Promise.resolve(summaryRows),
        close: async () => {
          throw new Error('first close failed');
        },
      }),
      stubConnection({
        readObjectsCancellable: () => Promise.resolve(summaryRows),
        close: async () => {
          secondWorkerClosed = true;
        },
      }),
    ];
    const owner = stubConnection({
      run: (sql: string) => {
        droppedTables.push(sql);
        return Promise.resolve();
      },
      readObjects: () => Promise.resolve(summaryRows),
    });
    const executor = new DuckDbComparisonExecutor({
      acquireSource: async (workingCsvId) => ({
        tableName: workingCsvId,
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
        comparisonId: 'comparison',
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
