import { Data, Effect } from 'effect';
import type { QueryValues } from './query/csv-query';
import type { EngineRow } from './query/csv-result-normalization';

export const engineFailureMessage = 'The data engine could not complete the operation.';

export const stoppedEngineMessage = 'The data engine has stopped. Reload CSV Viewer to start a new workspace.';

/**
 * Interrupting a cancellable query requests cancellation and waits for the driver to settle.
 * Other operations are uninterruptible until settlement, keeping their resources alive throughout.
 */
export interface WorkspaceDatabaseConnection {
  run(sql: string, values?: QueryValues): Effect.Effect<void, DataEngineError>;
  readObjects(sql: string, values?: QueryValues): Effect.Effect<EngineRow[], DataEngineError>;
  /**
   * Runs long work through the engine's cancellable execution path. Kept separate from `run` and
   * `readObjects` because DuckDB-Wasm's cancellable path holds one connection's single result
   * stream, so it cannot interleave with the concurrent short queries the owner connection serves.
   */
  runCancellable(sql: string): Effect.Effect<void, DataEngineError>;
  readObjectsCancellable(sql: string, values?: QueryValues): Effect.Effect<EngineRow[], DataEngineError>;
  close(): Effect.Effect<void, DataEngineError>;
}

/**
 * One acquired in-memory database with an owner connection and isolated operation connections.
 * The workspace runtime acquires it before the workspace exists and releases it after every
 * Working CSV table, so it is open for the whole life of every caller. Callers own the worker
 * connections they acquire and close each one.
 */
export interface WorkspaceDatabase {
  ownerConnection(): Effect.Effect<WorkspaceDatabaseConnection, DataEngineError>;
  connectWorker(): Effect.Effect<WorkspaceDatabaseConnection, DataEngineError>;
  run(sql: string, values?: QueryValues): Effect.Effect<void, DataEngineError>;
  readObjects(sql: string, values?: QueryValues): Effect.Effect<EngineRow[], DataEngineError>;
}

/** A runtime's database with the release steps the database Layer's finalizer runs in order. */
export interface OwnedWorkspaceDatabase extends WorkspaceDatabase {
  closeOwnerConnection(): Effect.Effect<void, DataEngineError>;
  /** Stops the engine: the native instance, or the Wasm Worker. Runs even if the connection close failed. */
  closeEngine(): Effect.Effect<void, DataEngineError>;
}

/** An expected engine failure, classified at the runtime edge. The fixed message keeps driver details from users. */
export class DataEngineError extends Data.TaggedError('DataEngineError')<{ cause: unknown }> {
  override readonly message = engineFailureMessage;
}

/**
 * Classifies driver throws and rejections as DataEngineError at the runtime edge.
 * Interruption follows the connection contract above; a failed cancellation still waits for settlement.
 */
export function driverEffect<A>(
  operation: () => Promise<A>,
  cancel?: () => Promise<void>,
): Effect.Effect<A, DataEngineError> {
  const toEngineError = (cause: unknown) => new DataEngineError({ cause });
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
      Effect.ignore,
      Effect.ensuring(Effect.promise(() => pending.then(() => undefined, () => undefined))),
    );
  });
}
