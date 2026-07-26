import { describe, expect, it } from 'vitest';
import { DuckDBInstance, type DuckDBConnection } from '@duckdb/node-api';
import { DuckDbComparisonExecutor } from './duckdb-comparison-executor';

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
      getSource: () => ({
        tableName: 'source',
        columns: [{ name: 'id', type: 'VARCHAR' }],
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
      getSource: () => ({
        tableName: 'source',
        columns: [{ name: 'id', type: 'VARCHAR' }],
      }),
      getOwnerConnection: async () => connection,
      connectWorker: () =>
        new Promise((resolve) => {
          resolveConnection = resolve;
        }),
    });

    const validation = executor.validateKey('operation', 'source', ['id']);
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
      getSource: () => ({
        tableName: 'source',
        columns: [{ name: 'id', type: 'VARCHAR' }],
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
    const executor = new DuckDbComparisonExecutor({
      getSource: (sessionId) => ({
        tableName: sessionId,
        columns: [
          { name: 'id', type: 'VARCHAR' },
          { name: 'value', type: 'VARCHAR' },
        ],
      }),
      getOwnerConnection: async () => owner,
      connectWorker: () => database.connect(),
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
      await new Promise((resolve) => setTimeout(resolve, 10));
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
  }, 10_000);
});
