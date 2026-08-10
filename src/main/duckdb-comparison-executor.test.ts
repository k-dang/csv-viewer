import { describe, expect, it } from 'vitest';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { DuckDbComparisonExecutor } from './duckdb-comparison-executor';

async function waitWithTimeout(
  promise: Promise<void>,
  timeoutMs: number,
  message: string,
): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      promise,
      new Promise<void>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error(message)), timeoutMs);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

describe('DuckDbComparisonExecutor worker lifecycle', () => {
  it('interrupts an active operation before releasing its dedicated connection', async () => {
    let interrupted = false;
    let closed = false;
    let rejectQuery: ((error: Error) => void) | null = null;
    const connection = {
      runAndReadAll: () =>
        new Promise((_resolve, reject) => {
          rejectQuery = reject;
        }),
      interrupt: () => {
        interrupted = true;
        rejectQuery?.(new Error('interrupted'));
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
    await new Promise((resolve) => setTimeout(resolve, 0));
    executor.cancel('operation');

    await expect(validation).rejects.toThrow('interrupted');
    expect(interrupted).toBe(true);
    expect(closed).toBe(false);
    await executor.release('operation');
    expect(closed).toBe(true);
  });

  it('releases a worker when cancellation wins the connection race', async () => {
    let closed = false;
    let resolveConnection: ((connection: DuckDBConnection) => void) | null = null;
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
      connectWorker: () =>
        new Promise((resolve) => {
          resolveConnection = resolve;
        }),
    });

    const validation = executor.validateKey('operation', 'source', ['id']);
    await new Promise((resolve) => setTimeout(resolve, 0));
    executor.cancel('operation');
    resolveConnection?.(connection);

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

  it('interrupts real snapshot work without disrupting the owner connection or leaving staging', async () => {
    const database = await DuckDBInstance.create(':memory:');
    const owner = await database.connect();
    await owner.run(`CREATE TABLE baseline_active AS SELECT
      'b1' AS "__csvViewerRowId", 1 AS "__csvViewerSourceOrder",
      false AS "__csvViewerDeleted", '1' AS id, 'old' AS value`);
    await owner.run(`CREATE TABLE candidate_active AS SELECT
      'c1' AS "__csvViewerRowId", 1 AS "__csvViewerSourceOrder",
      false AS "__csvViewerDeleted", '1' AS id, 'new' AS value`);
    await owner.run(`CREATE VIEW baseline AS SELECT
      'b' || i::VARCHAR AS "__csvViewerRowId", i AS "__csvViewerSourceOrder",
      false AS "__csvViewerDeleted", i::VARCHAR AS id, sin(i::DOUBLE)::VARCHAR AS value
      FROM range(100000000) source(i)`);
    await owner.run(`CREATE VIEW candidate AS SELECT
      'c' || i::VARCHAR AS "__csvViewerRowId", i AS "__csvViewerSourceOrder",
      false AS "__csvViewerDeleted", i::VARCHAR AS id, cos(i::DOUBLE)::VARCHAR AS value
      FROM range(100000000) source(i)`);
    let markSnapshotRunIssued: (() => void) | null = null;
    const snapshotRunIssued = new Promise<void>((resolve) => {
      markSnapshotRunIssued = resolve;
    });
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
      connectWorker: async () => {
        const connection = await database.connect();
        return new Proxy(connection, {
          get(target, property) {
            if (property === 'run') {
              return (sql: string) => {
                const query = target.run(sql);
                if (sql.includes('csv_comparison_real_interruption')) {
                  markSnapshotRunIssued?.();
                }
                return query;
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      },
    });

    try {
      await executor.createSnapshot({
        artifactId: 'active',
        baselineId: 'baseline_active',
        candidateId: 'candidate_active',
        key: ['id'],
        valueColumns: ['value'],
      });
      await executor.release('active');
      const activeWindow = {
        artifactId: 'active',
        keyCount: 1,
        columnIndexes: [0],
        offset: 0,
        limit: 10,
        differencesOnly: false,
        swapped: false,
      };
      await expect(executor.readWindow(activeWindow)).resolves.toMatchObject({
        totalRowCount: 1,
        rows: [{ classification: 'changed', keyValues: ['1'] }],
      });

      const snapshot = executor.createSnapshot({
        artifactId: 'real-interruption',
        baselineId: 'baseline',
        candidateId: 'candidate',
        key: ['id'],
        valueColumns: ['value'],
      });
      await waitWithTimeout(
        snapshotRunIssued,
        2_000,
        'Comparison snapshot query was not issued within 2 seconds.',
      );
      executor.cancel('real-interruption');

      await expect(snapshot).rejects.toThrow();
      await executor.release('real-interruption');
      await expect(executor.readWindow(activeWindow)).resolves.toMatchObject({
        totalRowCount: 1,
        rows: [{ classification: 'changed', keyValues: ['1'] }],
      });
      const ownerResult = await owner.runAndReadAll('SELECT 42 AS answer');
      expect(Number(ownerResult.getRowObjectsJS()[0].answer)).toBe(42);
      const artifactResult = await owner.runAndReadAll(
        `SELECT count(*)::BIGINT AS count FROM information_schema.tables WHERE table_name = 'csv_comparison_real_interruption'`,
      );
      expect(Number(artifactResult.getRowObjectsJS()[0].count)).toBe(0);
    } finally {
      await executor.dispose();
      owner.closeSync();
      database.closeSync();
    }
  }, 20_000);
});
