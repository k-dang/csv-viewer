import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DuckDbWorkspaceDatabase } from './duckdb-database';

let database: DuckDbWorkspaceDatabase;

beforeEach(async () => {
  database = await DuckDbWorkspaceDatabase.open();
});

afterEach(async () => {
  await database.closeOwnerConnection();
  await database.closeEngine();
});

describe('DuckDbWorkspaceDatabase', () => {
  it('normalizes driver query errors', async () => {
    await expect(database.readObjects('SELECT * FROM missing_table')).rejects.toMatchObject({
      name: 'DataEngineError',
      message: 'The data engine could not complete the operation.',
    });
  });

  it('interrupts long work without publishing its table and keeps the connection usable', async () => {
    const worker = await database.connectWorker();
    const work = worker.runCancellable(
      'CREATE TABLE cancelled_native_work AS SELECT sum(a.range * b.range) FROM range(1000000) a, range(1000000) b',
    );
    await new Promise((resolve) => setTimeout(resolve, 20));

    await worker.cancelRunning();

    await expect(work).rejects.toThrow();
    await expect(
      database.readObjects(
        "SELECT count(*)::BIGINT AS count FROM information_schema.tables WHERE table_name = 'cancelled_native_work'",
      ),
    ).resolves.toEqual([{ count: 0n }]);
    await expect(worker.readObjects('SELECT 42 AS answer')).resolves.toEqual([{ answer: 42 }]);
    await worker.close();
  }, 15_000);
});
