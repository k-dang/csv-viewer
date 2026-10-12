import { Data, Predicate } from 'effect';
import type { DataEngineError } from './database';
import type { CsvSourceUnavailableError } from './workspace-host';

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

const expectedWorkspaceErrorTags = {
  WorkspaceRequestError: true,
  CsvOpenError: true,
  DataEngineError: true,
  CsvSourceUnavailableError: true,
} satisfies Record<ExpectedWorkspaceError['_tag'], true>;

export function isExpectedWorkspaceError(cause: unknown): cause is ExpectedWorkspaceError {
  return Predicate.hasProperty(cause, '_tag') && Predicate.isString(cause._tag) && Object.hasOwn(expectedWorkspaceErrorTags, cause._tag);
}

/** Narrows an unknown thrown value to an Error, so failures can be collected and re-thrown. */
export function toError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}
