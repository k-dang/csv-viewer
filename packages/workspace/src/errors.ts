import { Cause, Data, Effect } from 'effect';
import { DataEngineError } from './database';
import { CsvSourceUnavailableError } from './workspace-host';

/** A deliberate request rejection whose message is safe to show to the user. */
export class WorkspaceRequestError extends Data.TaggedError('WorkspaceRequestError')<{ message: string }> {}

export const genericWorkspaceFailure = 'The CSV workspace could not complete the request.';

export function isExpectedWorkspaceError(cause: unknown): cause is WorkspaceRequestError | DataEngineError | CsvSourceUnavailableError {
  return cause instanceof WorkspaceRequestError || cause instanceof DataEngineError || cause instanceof CsvSourceUnavailableError;
}

/** Put recognized rejections in Effect's failure channel; retain all other throws as defects. */
export function attemptWorkspacePromise<A>(operation: () => Promise<A>) {
  return Effect.tryPromise({ try: operation, catch: (cause) => cause }).pipe(
    Effect.catchCause(classifyCaughtCause),
  );
}

export function attemptWorkspaceSync<A>(operation: () => A) {
  return Effect.try({ try: operation, catch: (cause) => cause }).pipe(
    Effect.catchCause(classifyCaughtCause),
  );
}

function classifyCaughtCause(cause: Cause.Cause<unknown>) {
  const [reason] = cause.reasons;
  if (cause.reasons.length !== 1 || reason._tag !== 'Fail') {
    // SAFETY: This branch preserves the original cause; its failure type is not exposed by the adapter.
    return Effect.failCause(cause as Cause.Cause<never>);
  }
  return isExpectedWorkspaceError(reason.error) ? Effect.fail(reason.error) : Effect.die(reason.error);
}

/** Narrows an unknown thrown value to an Error, so failures can be collected and re-thrown. */
export function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
