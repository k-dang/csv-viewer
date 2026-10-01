import { Data } from 'effect';
import { DataEngineError } from './database';
import { CsvSourceUnavailableError } from './workspace-host';

/** A deliberate request rejection whose message is safe to show to the user. */
export class WorkspaceRequestError extends Data.TaggedError('WorkspaceRequestError')<{ message: string }> {}

export const genericWorkspaceFailure = 'The CSV workspace could not complete the request.';

/** The only rejection for a payload that does not decode as a CsvViewer request. It never includes decode issues. */
export const malformedRequestMessage = 'Malformed CSV Viewer request.';

export function isExpectedWorkspaceError(cause: unknown): cause is WorkspaceRequestError | DataEngineError | CsvSourceUnavailableError {
  return cause instanceof WorkspaceRequestError || cause instanceof DataEngineError || cause instanceof CsvSourceUnavailableError;
}

/** Narrows an unknown thrown value to an Error, so failures can be collected and re-thrown. */
export function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
