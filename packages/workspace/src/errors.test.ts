import { describe, expect, it } from 'vitest';
import { DataEngineError } from './database';
import { CsvOpenError, isExpectedWorkspaceError, WorkspaceRequestError } from './errors';
import { CsvSourceUnavailableError } from './workspace-host';

describe('isExpectedWorkspaceError', () => {
  it.each([
    new WorkspaceRequestError({ message: 'Working CSV is closing.' }),
    new CsvOpenError({ message: 'Delimiter must be exactly one character.', category: 'dialect' }),
    new DataEngineError({ cause: new Error('driver') }),
    new CsvSourceUnavailableError({ code: 'permission-denied', message: 'Permission was denied for the CSV Source.' }),
  ])('accepts a declared $_tag', (error) => {
    expect(isExpectedWorkspaceError(error)).toBe(true);
  });

  it.each([
    ['a plain Error with a declared message', new Error('Working CSV is closing.')],
    ['a plain object with a declared tag', { _tag: 'WorkspaceRequestError', message: 'PRIVATE detail' }],
    ['an undeclared tag', { _tag: 'ComparisonCleanupError', message: 'cleanup' }],
    ['a non-string tag', { _tag: 1 }],
    ['an inherited tag name', { _tag: 'toString' }],
  ])('rejects %s', (_name, error) => {
    expect(isExpectedWorkspaceError(error)).toBe(false);
  });
});
