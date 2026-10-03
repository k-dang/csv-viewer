import { Data, Effect } from 'effect';
import { engineFailureMessage, type DataEngineError } from '../database';

/** A failed Comparison resource release. It travels as a defect so diagnostics report `cleanup-failed`, not the attempt outcome. */
export class ComparisonCleanupError extends Data.TaggedError('ComparisonCleanupError')<{ cause: DataEngineError }> {
  override readonly message = engineFailureMessage;
}

/** Keeps typed database release failures distinct from the attempt outcome. */
export function cleanupEffect<A>(operation: Effect.Effect<A, DataEngineError>): Effect.Effect<A> {
  return operation.pipe(
    Effect.mapError((cause) => new ComparisonCleanupError({ cause })),
    Effect.orDie,
  );
}
