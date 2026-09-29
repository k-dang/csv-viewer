import { Result } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  buildAddColumnStatement,
  buildDropColumnStatement,
  buildExistingRowIdsQuery,
  buildColumnValueCountsQuery,
  buildColumnValuesQuery,
  buildRenameColumnStatement,
  buildRowDeletionStatement,
  buildRowsQuery,
} from './csv-query';

function failureMessage<A>(result: Result.Result<A, { message: string }>): string | undefined {
  return Result.isFailure(result) ? result.failure.message : undefined;
}

describe('CSV row identifier statements', () => {
  it('rejects an empty row list rather than emitting IN ()', () => {
    expect(failureMessage(buildRowDeletionStatement('csv_working_1', [], true))).toBe(
      'At least one CSV row is required.',
    );
    expect(failureMessage(buildExistingRowIdsQuery('csv_working_1', []))).toBe(
      'At least one CSV row is required.',
    );
  });

  it('emits one placeholder per row identifier', () => {
    expect(Result.getOrThrow(buildRowDeletionStatement('csv_working_1', ['1', '2'], true))).toMatchObject({
      values: [true, '1', '2'],
    });
    expect(Result.getOrThrow(buildExistingRowIdsQuery('csv_working_1', ['1', '2'])).sql).toContain('IN (?, ?)');
  });
});

describe('CSV query column validation', () => {
  const scope = { tableName: 'csv_working_1', columns: [{ name: 'name', type: 'VARCHAR' }], search: '' };
  const unknown = 'Unknown CSV column: missing';

  it('rejects an unknown filter, sort, or requested column with the validation message', () => {
    const filters = [{ kind: 'text' as const, column: 'missing', operator: 'blank' as const }];
    const sort = [{ column: 'missing', direction: 'asc' as const }];
    expect(failureMessage(buildRowsQuery({ ...scope, filters, sort: [], limit: 10, offset: 0 }))).toBe(unknown);
    expect(failureMessage(buildRowsQuery({ ...scope, filters: [], sort, limit: 10, offset: 0 }))).toBe(unknown);
    expect(failureMessage(buildColumnValuesQuery({ ...scope, column: 'missing', filters: [], sort: [] }))).toBe(unknown);
    expect(failureMessage(buildColumnValueCountsQuery({ ...scope, column: 'missing', filters: [] }))).toBe(unknown);
  });
});

describe('CSV column rename statements', () => {
  it('quotes table and column identifiers including embedded quotes', () => {
    expect(buildRenameColumnStatement('csv"working', 'quote"name', 'new"name')).toBe(
      'ALTER TABLE "csv""working" RENAME COLUMN "quote""name" TO "new""name"',
    );
  });

  it('adds a varchar column with an empty-string default and drops it by name', () => {
    expect(buildAddColumnStatement('csv"working', 'New column')).toBe(
      'ALTER TABLE "csv""working" ADD COLUMN "New column" VARCHAR DEFAULT \'\'',
    );
    expect(buildDropColumnStatement('csv"working', 'quote"name')).toBe(
      'ALTER TABLE "csv""working" DROP COLUMN "quote""name"',
    );
  });
});
