import { DuckDBConnection, DuckDBPendingResult } from '@duckdb/node-api';
import { Effect } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';
import { describeDatabaseInterruption, driverMethod } from '../../../../packages/workspace/test/contract/database-interruption.contract';
import { DuckDbWorkspaceDatabase } from './duckdb-database';

describeDatabaseInterruption('DuckDbWorkspaceDatabase', {
  open: () => Effect.runPromise(DuckDbWorkspaceDatabase.open()),
  cancellableStart: driverMethod(DuckDBConnection.prototype, 'start'),
  cancellableExecution: driverMethod(DuckDBPendingResult.prototype, 'readAll'),
  read: driverMethod(DuckDBConnection.prototype, 'runAndReadAll'),
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Comparison cancellation still uses the Promise surface until the executor moves to Effects.
it('cancels Promise-surface work cancelled before the driver starts executing it', async () => {
  const database = await Effect.runPromise(DuckDbWorkspaceDatabase.open());
  const worker = await database.connectWorker();
  const started = driverMethod(DuckDBConnection.prototype, 'start').observe();
  const work = worker.runCancellable(
    'CREATE TABLE cancelled_work AS SELECT sum(a.range * b.range) FROM range(1000000) a, range(1000000) b',
  );
  await started;

  await worker.cancelRunning();

  await expect(work).rejects.toThrow();
  await expect(database.readObjects(
    "SELECT count(*)::BIGINT AS count FROM information_schema.tables WHERE table_name = 'cancelled_work'",
  )).resolves.toEqual([{ count: 0n }]);
  await worker.close();
  await Effect.runPromise(database.closeOwnerConnection());
  await Effect.runPromise(database.closeEngine());
}, 15_000);
