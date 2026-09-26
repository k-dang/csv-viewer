import { Effect } from 'effect';
import { DataEngineError, type WorkspaceDatabaseConnection } from '../database';

export class ComparisonCleanupError extends DataEngineError {
  override name = 'ComparisonCleanupError';
}

export function databaseEffect<A>(operation: () => Promise<A>): Effect.Effect<A, DataEngineError> {
  return Effect.tryPromise({
    try: operation,
    catch: (cause) => cause instanceof DataEngineError ? cause : new DataEngineError(cause),
  });
}

export function cleanupEffect<A>(operation: () => Promise<A>): Effect.Effect<A> {
  return Effect.tryPromise({
    try: operation,
    catch: (cause) => new ComparisonCleanupError(cause),
  }).pipe(Effect.orDie);
}

/** Interruption must stop and await the driver query before scopes can release its resources. */
export function comparisonQuery<A>(
  connection: WorkspaceDatabaseConnection,
  operation: () => Promise<A>,
): Effect.Effect<A, DataEngineError> {
  return Effect.callback<A, DataEngineError>((resume) => {
    let query: Promise<A>;
    try {
      query = operation();
    } catch (cause) {
      resume(Effect.fail(cause instanceof DataEngineError ? cause : new DataEngineError(cause)));
      return;
    }
    query.then(
      (value) => resume(Effect.succeed(value)),
      (cause) => resume(Effect.fail(cause instanceof DataEngineError ? cause : new DataEngineError(cause))),
    );
    return cleanupEffect(() => connection.cancelRunning()).pipe(
      Effect.ensuring(Effect.promise(() => query.then(() => undefined, () => undefined))),
    );
  });
}
