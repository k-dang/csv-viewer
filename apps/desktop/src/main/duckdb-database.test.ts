import { DuckDBConnection, DuckDBPendingResult } from '@duckdb/node-api';
import { Effect } from 'effect';
import { describeDatabaseInterruption, driverMethod } from '../../../../packages/workspace/test/contract/database-interruption.contract';
import { DuckDbWorkspaceDatabase } from './duckdb-database';

describeDatabaseInterruption('DuckDbWorkspaceDatabase', {
  open: () => Effect.runPromise(DuckDbWorkspaceDatabase.open()),
  cancellableStart: driverMethod(DuckDBConnection.prototype, 'start'),
  cancellableExecution: driverMethod(DuckDBPendingResult.prototype, 'readAll'),
  read: driverMethod(DuckDBConnection.prototype, 'runAndReadAll'),
});
