import { Data } from 'effect';
import { DataEngineError } from './database';
import { CsvSourceUnavailableError } from './workspace-host';

/** A deliberate request rejection whose message is safe to show to the user. `cause` is never shown. */
export class WorkspaceRequestError extends Data.TaggedError('WorkspaceRequestError')<{ message: string; cause?: unknown }> {}

/** A CSV Source that could not become a Working CSV, with product guidance and a diagnostic category. */
export class CsvOpenError extends Data.TaggedError('CsvOpenError')<{
  message: string;
  category: 'source-access' | 'dialect' | 'engine';
}> {}

export const genericWorkspaceFailure = 'The CSV workspace could not complete the request.';

/** The only rejection for a payload that does not decode as a CsvViewer request. It never includes decode issues. */
export const malformedRequestMessage = 'Malformed CSV Viewer request.';

/** The declared failures a request may end with. Each carries a message that is safe to show the user. */
export type ExpectedWorkspaceError = WorkspaceRequestError | CsvOpenError | DataEngineError | CsvSourceUnavailableError;

/** Only these classes' messages are safe to show; a look-alike object with a matching `_tag` is not. */
const expectedWorkspaceErrors = {
  WorkspaceRequestError,
  CsvOpenError,
  DataEngineError,
  CsvSourceUnavailableError,
} satisfies { [Tag in ExpectedWorkspaceError['_tag']]: abstract new (...args: never[]) => Extract<ExpectedWorkspaceError, { _tag: Tag }> };

export function isExpectedWorkspaceError(cause: unknown): cause is ExpectedWorkspaceError {
  return Object.values(expectedWorkspaceErrors).some((ExpectedError) => cause instanceof ExpectedError);
}

/** Narrows an unknown thrown value to an Error, so failures can be collected and re-thrown. */
export function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
