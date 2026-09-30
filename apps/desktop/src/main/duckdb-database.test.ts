import { DuckDBConnection, DuckDBPendingResult } from '@duckdb/node-api';
import { Cause, Effect, Exit, Fiber } from 'effect';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { holdDriverSettlement, observeDriverCall, observeInterruption } from '../../../../packages/workspace/test/driver-settlement';
import { DuckDbWorkspaceDatabase } from './duckdb-database';

const longQuery = 'SELECT sum(a.range * b.range) AS total FROM range(1000000) a, range(1000000) b';

let database: DuckDbWorkspaceDatabase;

beforeEach(async () => {
  database = await Effect.runPromise(DuckDbWorkspaceDatabase.open());
});

afterEach(async () => {
  vi.restoreAllMocks();
  await Effect.runPromise(database.closeOwnerConnection());
  await Effect.runPromise(database.closeEngine());
});

describe('DuckDbWorkspaceDatabase', () => {
  it('fails driver errors as a sanitized DataEngineError', async () => {
    const exit = await Effect.runPromiseExit(database.readObjectsEffect('SELECT * FROM missing_table'));

    if (!Exit.isFailure(exit)) throw new Error('Expected the query to fail.');
    expect(Cause.hasDies(exit.cause)).toBe(false);
    const [failure] = exit.cause.reasons.filter(Cause.isFailReason).map((reason) => reason.error);
    expect(failure).toMatchObject({
      name: 'DataEngineError',
      message: 'The data engine could not complete the operation.',
    });
    expect(failure.message).not.toContain('missing_table');
  });

  it('cancels long work interrupted before the driver starts executing it', async () => {
    const worker = await Effect.runPromise(database.connectWorkerEffect());
    const started = observeDriverCall(DuckDBConnection.prototype, 'start');
    const work = Effect.runFork(worker.runCancellableEffect(`CREATE TABLE cancelled_work AS ${longQuery}`));
    await started;

    await observeInterruption(work).done;

    expect(Exit.hasInterrupts(await Effect.runPromise(Fiber.await(work)))).toBe(true);
    await expect(Effect.runPromise(database.readObjectsEffect(
      "SELECT count(*)::BIGINT AS count FROM information_schema.tables WHERE table_name = 'cancelled_work'",
    ))).resolves.toEqual([{ count: 0n }]);
    await expect(Effect.runPromise(worker.readObjectsEffect('SELECT 42 AS answer'))).resolves.toEqual([{ answer: 42 }]);
    await Effect.runPromise(worker.closeEffect());
  }, 15_000);

  it('waits for cancelled driver work to settle before interruption completes', async () => {
    const execution = holdDriverSettlement(DuckDBPendingResult.prototype, 'readAll');
    const worker = await Effect.runPromise(database.connectWorkerEffect());
    const work = Effect.runFork(worker.readObjectsCancellableEffect(longQuery));
    await execution.entered;

    const interruption = observeInterruption(work);
    await vi.waitFor(() => expect(execution.settled).toHaveBeenCalled(), { timeout: 10_000 });
    await new Promise((resolve) => setImmediate(resolve));
    expect(interruption.state.completed).toBe(false);

    execution.release();
    await interruption.done;
    expect(Exit.hasInterrupts(await Effect.runPromise(Fiber.await(work)))).toBe(true);
    await expect(Effect.runPromise(worker.readObjectsEffect('SELECT 42 AS answer'))).resolves.toEqual([{ answer: 42 }]);
    await Effect.runPromise(worker.closeEffect());
  }, 15_000);

  it('completes interruption of non-cancellable work only after the driver settles', async () => {
    const query = holdDriverSettlement(DuckDBConnection.prototype, 'runAndReadAll');
    const work = Effect.runFork(database.readObjectsEffect('SELECT 42 AS answer'));
    await query.entered;

    const interruption = observeInterruption(work);
    await vi.waitFor(() => expect(query.settled).toHaveBeenCalled());
    await new Promise((resolve) => setImmediate(resolve));
    expect(interruption.state.completed).toBe(false);

    query.release();
    await interruption.done;
    expect(Exit.hasInterrupts(await Effect.runPromise(Fiber.await(work)))).toBe(true);
  });
});
