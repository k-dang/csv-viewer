import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { Effect } from 'effect';
import {
  driverEffect,
  type DataEngineError,
  type OwnedWorkspaceDatabase,
  type WorkspaceDatabaseConnection,
} from '@csv-viewer/workspace/database';
import type { QueryValues } from '@csv-viewer/workspace/csv-query';
import type { EngineRow } from '@csv-viewer/workspace/csv-result-normalization';

class NativeDuckDbConnection implements WorkspaceDatabaseConnection {
  constructor(private readonly connection: DuckDBConnection) {}

  run(sql: string, values?: QueryValues): Effect.Effect<void, DataEngineError> {
    return driverEffect(() => this.connection.run(sql, values)).pipe(Effect.asVoid);
  }

  readObjects(sql: string, values?: QueryValues): Effect.Effect<EngineRow[], DataEngineError> {
    return driverEffect(async () => (await this.connection.runAndReadAll(sql, values)).getRowObjectsJS());
  }

  runCancellable(sql: string): Effect.Effect<void, DataEngineError> {
    return this.readObjectsCancellable(sql).pipe(Effect.asVoid);
  }

  /**
   * DuckDB clears a connection's interrupt when a query starts, so an interrupt sent before then
   * is lost. The query therefore starts as a pending result first, and a cancellation that arrived
   * meanwhile interrupts it again before it executes.
   */
  readObjectsCancellable(sql: string, values?: QueryValues): Effect.Effect<EngineRow[], DataEngineError> {
    return Effect.suspend(() => {
      let cancelled = false;
      return driverEffect(async () => {
        const pending = await this.connection.start(sql, values);
        if (cancelled) this.connection.interrupt();
        return (await pending.readAll()).getRowObjectsJS();
      }, async () => {
        cancelled = true;
        this.connection.interrupt();
      });
    });
  }

  close(): Effect.Effect<void, DataEngineError> {
    return driverEffect(async () => this.connection.closeSync());
  }
}

/**
 * The native in-memory database, open from `open` until the workspace runtime releases it. This is
 * the only module that opens, closes, or hands out native connections, so the workspace above it
 * never holds a driver type.
 */
export class DuckDbWorkspaceDatabase implements OwnedWorkspaceDatabase {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly connection: NativeDuckDbConnection,
  ) {}

  static open(): Effect.Effect<DuckDbWorkspaceDatabase, DataEngineError> {
    return driverEffect(async () => {
      const instance = await DuckDBInstance.create(':memory:');
      try {
        return new DuckDbWorkspaceDatabase(instance, new NativeDuckDbConnection(await instance.connect()));
      } catch (error) {
        instance.closeSync();
        throw error;
      }
    });
  }

  ownerConnection(): Effect.Effect<WorkspaceDatabaseConnection, DataEngineError> {
    return Effect.succeed(this.connection);
  }

  connectWorker(): Effect.Effect<WorkspaceDatabaseConnection, DataEngineError> {
    return driverEffect(async () => new NativeDuckDbConnection(await this.instance.connect()));
  }

  run(sql: string, values?: QueryValues): Effect.Effect<void, DataEngineError> {
    return this.connection.run(sql, values);
  }

  readObjects(sql: string, values?: QueryValues): Effect.Effect<EngineRow[], DataEngineError> {
    return this.connection.readObjects(sql, values);
  }

  closeOwnerConnection(): Effect.Effect<void, DataEngineError> {
    return this.connection.close();
  }

  closeEngine(): Effect.Effect<void, DataEngineError> {
    return driverEffect(async () => this.instance.closeSync());
  }
}
