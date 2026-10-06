import { DuckDBConnection, DuckDBInstance, DuckDBPendingResult } from '@duckdb/node-api';
import { Effect, Fiber } from 'effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { describeDatabaseInterruption, driverMethod } from '../../../../packages/workspace/test/contract/database-interruption.contract';
import { DuckDbWorkspaceDatabase } from './duckdb-database';

describeDatabaseInterruption('DuckDbWorkspaceDatabase', {
  open: () => DuckDbWorkspaceDatabase.open(),
  cancellableStart: driverMethod(DuckDBConnection.prototype, 'start'),
  cancellableExecution: driverMethod(DuckDBPendingResult.prototype, 'readAll'),
  read: driverMethod(DuckDBConnection.prototype, 'runAndReadAll'),
});

describe('DuckDbWorkspaceDatabase startup interruption', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it.each(['instance', 'connection'] as const)('releases what it acquired when interrupted while acquiring the %s', async (pending) => {
    const acquisition = pending === 'instance'
      ? driverMethod(DuckDBInstance, 'create').hold()
      : driverMethod(DuckDBInstance.prototype, 'connect').hold();
    const closeInstance = vi.spyOn(DuckDBInstance.prototype, 'closeSync');
    const closeConnection = vi.spyOn(DuckDBConnection.prototype, 'closeSync');
    const opening = Effect.runFork(Effect.scoped(DuckDbWorkspaceDatabase.open()));
    await acquisition.entered;

    const interruption = Effect.runPromise(Fiber.interrupt(opening));
    acquisition.release();
    await interruption;

    expect(closeInstance).toHaveBeenCalledOnce();
    if (pending === 'instance') {
      expect(closeConnection).not.toHaveBeenCalled();
    } else {
      expect(closeConnection).toHaveBeenCalledOnce();
      expect(closeConnection.mock.invocationCallOrder[0]).toBeLessThan(closeInstance.mock.invocationCallOrder[0]);
    }
  });
});
