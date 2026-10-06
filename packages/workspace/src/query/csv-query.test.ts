import { Result } from 'effect';
import { describe, expect, it } from 'vitest';
import {
  buildExistingRowIdsQuery,
  buildColumnValueCountsQuery,
  buildColumnValuesQuery,
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
});

describe('CSV query column validation', () => {
  const scope = { tableName: 'csv_working_1', columns: [{ name: 'name', type: 'VARCHAR' }], search: '' };
  const unknown = 'Unknown CSV column: missing';

  it('rejects an unknown filter, sort, or requested column with the validation message', () => {
    const filters = [{ kind: 'text' as const, column: 'missing', operator: 'contains' as const, value: '' }];
    const sort = [{ column: 'missing', direction: 'asc' as const }];
    expect(failureMessage(buildRowsQuery({ ...scope, filters, sort: [], limit: 10, offset: 0 }))).toBe(unknown);
    expect(failureMessage(buildRowsQuery({ ...scope, filters: [], sort, limit: 10, offset: 0 }))).toBe(unknown);
    expect(failureMessage(buildColumnValuesQuery({ ...scope, column: 'missing', filters: [], sort: [] }))).toBe(unknown);
    expect(failureMessage(buildColumnValueCountsQuery({ ...scope, column: 'missing', filters: [] }))).toBe(unknown);
  });
});
