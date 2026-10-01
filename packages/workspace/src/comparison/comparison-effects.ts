import { Effect } from 'effect';
import { DataEngineError } from '../database';

export class ComparisonCleanupError extends DataEngineError {
  override name = 'ComparisonCleanupError';
}

/** Keeps typed database release failures distinct from the attempt outcome. */
export function cleanupEffect<A>(operation: Effect.Effect<A, DataEngineError>): Effect.Effect<A> {
  return operation.pipe(
    Effect.mapError((cause) => new ComparisonCleanupError(cause)),
    Effect.orDie,
  );
}
