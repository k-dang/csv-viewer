import { describe, expect, it } from 'vitest';
import { buildExistingRowIdsQuery, buildRowDeletionStatement } from './csv-query';

describe('CSV row identifier statements', () => {
  it('rejects an empty row list rather than emitting IN ()', () => {
    expect(() => buildRowDeletionStatement('csv_working_1', [], true)).toThrow(
      'At least one CSV row is required.',
    );
    expect(() => buildExistingRowIdsQuery('csv_working_1', [])).toThrow(
      'At least one CSV row is required.',
    );
  });

  it('emits one placeholder per row identifier', () => {
    expect(buildRowDeletionStatement('csv_working_1', ['1', '2'], true)).toMatchObject({
      values: [true, '1', '2'],
    });
    expect(buildExistingRowIdsQuery('csv_working_1', ['1', '2']).sql).toContain('IN (?, ?)');
  });
});
