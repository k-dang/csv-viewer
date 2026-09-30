import { Effect } from 'effect';
import type { QueryValues } from './query/csv-query';
import type { EngineRow } from './query/csv-result-normalization';

export const stoppedEngineMessage = 'The data engine has stopped. Reload CSV Viewer to start a new workspace.';

/**
 * The database operations the shared workspace needs from either DuckDB runtime.
 *
 * Interruption rule for the Effect operations: interrupting a cancellable query asks the driver to
 * cancel and completes only after the driver's pending work settles. Every other operation is
 * uninterruptible from start to driver settlement. Either way, a resource the query reads is never
 * released while the driver still uses it.
 *
 * The Promise methods are the surface unmigrated consumers still call; each one runs its Effect.
 */
export interface WorkspaceDatabaseConnection {
  run(sql: string, values?: QueryValues): Promise<void>;
  readObjects(sql: string, values?: QueryValues): Promise<EngineRow[]>;
  /**
   * Runs long work through the engine's cancellable execution path. Kept separate from `run` and
   * `readObjects` because DuckDB-Wasm's cancellable path holds one connection's single result
   * stream, so it cannot interleave with the concurrent short queries the owner connection serves.
   */
  runCancellable(sql: string): Promise<void>;
  readObjectsCancellable(sql: string, values?: QueryValues): Promise<EngineRow[]>;
  cancelRunning(): Promise<void>;
  close(): Promise<void>;
  runEffect(sql: string, values?: QueryValues): Effect.Effect<void, DataEngineError>;
  readObjectsEffect(sql: string, values?: QueryValues): Effect.Effect<EngineRow[], DataEngineError>;
  /** Runs long work on the cancellable path; interrupting it cancels the driver work. */
  runCancellableEffect(sql: string): Effect.Effect<void, DataEngineError>;
  readObjectsCancellableEffect(sql: string, values?: QueryValues): Effect.Effect<EngineRow[], DataEngineError>;
  closeEffect(): Effect.Effect<void, DataEngineError>;
}

/**
 * One acquired in-memory database with an owner connection and isolated operation connections.
 * The workspace runtime acquires it before the workspace exists and releases it after every
 * Working CSV table, so it is open for the whole life of every caller. Callers own the worker
 * connections they acquire and close each one. The Promise methods are the surface unmigrated
 * consumers still call.
 */
export interface WorkspaceDatabase {
  ownerConnection(): Promise<WorkspaceDatabaseConnection>;
  connectWorker(): Promise<WorkspaceDatabaseConnection>;
  run(sql: string, values?: QueryValues): Promise<void>;
  readObjects(sql: string, values?: QueryValues): Promise<EngineRow[]>;
  ownerConnectionEffect(): Effect.Effect<WorkspaceDatabaseConnection, DataEngineError>;
  connectWorkerEffect(): Effect.Effect<WorkspaceDatabaseConnection, DataEngineError>;
  runEffect(sql: string, values?: QueryValues): Effect.Effect<void, DataEngineError>;
  readObjectsEffect(sql: string, values?: QueryValues): Effect.Effect<EngineRow[], DataEngineError>;
}

/** A runtime's database with the release steps the database Layer's finalizer runs in order. */
export interface OwnedWorkspaceDatabase extends WorkspaceDatabase {
  closeOwnerConnection(): Effect.Effect<void, DataEngineError>;
  /** Stops the engine: the native instance, or the Wasm Worker. Runs even if the connection close failed. */
  closeEngine(): Effect.Effect<void, DataEngineError>;
}

export class DataEngineError extends Error {
  constructor(cause: unknown) {
    super('The data engine could not complete the operation.', { cause });
    this.name = 'DataEngineError';
  }
}

/**
 * Runs one driver call at a runtime adapter edge. Any rejection or synchronous throw becomes
 * `DataEngineError`, which keeps driver exception classes and messages behind the adapter.
 * Without `cancel`, the call is uninterruptible until it settles. With `cancel`, interruption asks
 * the driver to stop, then still waits for the call to settle.
 */
export function driverEffect<A>(
  operation: () => Promise<A>,
  cancel?: () => Promise<void>,
): Effect.Effect<A, DataEngineError> {
  const toEngineError = (cause: unknown) => new DataEngineError(cause);
  if (!cancel) return Effect.uninterruptible(Effect.tryPromise({ try: operation, catch: toEngineError }));
  return Effect.callback<A, DataEngineError>((resume) => {
    let pending: Promise<A>;
    try {
      pending = operation();
    } catch (cause) {
      resume(Effect.fail(toEngineError(cause)));
      return;
    }
    pending.then(
      (value) => resume(Effect.succeed(value)),
      (cause) => resume(Effect.fail(toEngineError(cause))),
    );
    return driverEffect(cancel).pipe(
      Effect.orDie,
      Effect.ensuring(Effect.promise(() => pending.then(() => undefined, () => undefined))),
    );
  });
}
