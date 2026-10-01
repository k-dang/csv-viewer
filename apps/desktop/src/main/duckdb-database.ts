import { DuckDBConnection, DuckDBInstance } from '@duckdb/node-api';
import { Effect, Fiber } from 'effect';
import {
  driverEffect,
  type DataEngineError,
  type OwnedWorkspaceDatabase,
  type WorkspaceDatabaseConnection,
} from '@csv-viewer/workspace/database';
import type { QueryValues } from '@csv-viewer/workspace/csv-query';
import type { EngineRow } from '@csv-viewer/workspace/csv-result-normalization';

export type DuckDbRow = EngineRow;

class NativeDuckDbConnection implements WorkspaceDatabaseConnection {
  /** Promise-surface cancellable queries, so `cancelRunning` can interrupt them by the same rule. */
  private readonly cancellableRuns = new Set<Fiber.Fiber<EngineRow[], DataEngineError>>();

  constructor(private readonly connection: DuckDBConnection) {}

  runEffect(sql: string, values?: QueryValues): Effect.Effect<void, DataEngineError> {
    return driverEffect(() => this.connection.run(sql, values)).pipe(Effect.asVoid);
  }

  readObjectsEffect(sql: string, values?: QueryValues): Effect.Effect<EngineRow[], DataEngineError> {
    return driverEffect(async () => (await this.connection.runAndReadAll(sql, values)).getRowObjectsJS());
  }

  runCancellableEffect(sql: string): Effect.Effect<void, DataEngineError> {
    return this.readObjectsCancellableEffect(sql).pipe(Effect.asVoid);
  }

  /**
   * DuckDB clears a connection's interrupt when a query starts, so an interrupt sent before then
   * is lost. The query therefore starts as a pending result first, and a cancellation that arrived
   * meanwhile interrupts it again before it executes.
   */
  readObjectsCancellableEffect(sql: string, values?: QueryValues): Effect.Effect<EngineRow[], DataEngineError> {
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

  closeEffect(): Effect.Effect<void, DataEngineError> {
    return driverEffect(async () => this.connection.closeSync());
  }

  run(sql: string, values?: QueryValues): Promise<void> {
    return Effect.runPromise(this.runEffect(sql, values));
  }

  readObjects(sql: string, values?: QueryValues): Promise<EngineRow[]> {
    return Effect.runPromise(this.readObjectsEffect(sql, values));
  }

  async runCancellable(sql: string): Promise<void> {
    await this.readObjectsCancellable(sql);
  }

  readObjectsCancellable(sql: string, values?: QueryValues): Promise<EngineRow[]> {
    const run = Effect.runFork(this.readObjectsCancellableEffect(sql, values));
    this.cancellableRuns.add(run);
    return Effect.runPromise(Fiber.join(run)).finally(() => this.cancellableRuns.delete(run));
  }

  cancelRunning(): Promise<void> {
    return Effect.runPromise(Effect.forEach(this.cancellableRuns, Fiber.interrupt, { discard: true }));
  }

  close(): Promise<void> {
    return Effect.runPromise(this.closeEffect());
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

  ownerConnectionEffect(): Effect.Effect<WorkspaceDatabaseConnection, DataEngineError> {
    return Effect.succeed(this.connection);
  }

  connectWorkerEffect(): Effect.Effect<WorkspaceDatabaseConnection, DataEngineError> {
    return driverEffect(async () => new NativeDuckDbConnection(await this.instance.connect()));
  }

  runEffect(sql: string, values?: QueryValues): Effect.Effect<void, DataEngineError> {
    return this.connection.runEffect(sql, values);
  }

  readObjectsEffect(sql: string, values?: QueryValues): Effect.Effect<EngineRow[], DataEngineError> {
    return this.connection.readObjectsEffect(sql, values);
  }

  ownerConnection(): Promise<WorkspaceDatabaseConnection> {
    return Effect.runPromise(this.ownerConnectionEffect());
  }

  connectWorker(): Promise<WorkspaceDatabaseConnection> {
    return Effect.runPromise(this.connectWorkerEffect());
  }

  run(sql: string, values?: QueryValues): Promise<void> {
    return this.connection.run(sql, values);
  }

  readObjects(sql: string, values?: QueryValues): Promise<DuckDbRow[]> {
    return this.connection.readObjects(sql, values);
  }

  closeOwnerConnection(): Effect.Effect<void, DataEngineError> {
    return this.connection.closeEffect();
  }

  closeEngine(): Effect.Effect<void, DataEngineError> {
    return driverEffect(async () => this.instance.closeSync());
  }
}
