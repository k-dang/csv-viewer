import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { Effect, type Scope } from 'effect';
import {
  driverEffect,
  acquireWithRelease,
  DataEngineError,
  type WorkspaceDatabase,
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
    return Effect.try({
      try: () => this.connection.closeSync(),
      catch: (cause) => new DataEngineError({ cause }),
    });
  }
}

/**
 * The native in-memory database, open from `open` until its scope closes. This is the only module
 * that opens, closes, or hands out native connections, so the workspace above it never holds a
 * driver type.
 */
export class DuckDbWorkspaceDatabase implements WorkspaceDatabase {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly connection: NativeDuckDbConnection,
  ) {}

  /** Closing the scope closes the owner connection, then the instance. */
  static open(): Effect.Effect<DuckDbWorkspaceDatabase, DataEngineError, Scope.Scope> {
    return Effect.gen(function* () {
      const instance = yield* acquireWithRelease('engine', driverEffect(() => DuckDBInstance.create(':memory:')), (opened) => Effect.try({
        try: () => opened.closeSync(),
        catch: (cause) => new DataEngineError({ cause }),
      }));
      const connection = yield* acquireWithRelease(
        'connection',
        driverEffect(async () => new NativeDuckDbConnection(await instance.connect())),
        (opened) => opened.close(),
      );
      return new DuckDbWorkspaceDatabase(instance, connection);
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
}
