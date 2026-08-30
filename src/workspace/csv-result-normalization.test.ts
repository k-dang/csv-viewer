import { describe, expect, it } from 'vitest';
import { csvInternalRowIdField } from '../shared/csv-viewer-contract';
import { normalizeRow, type EngineRow } from './csv-result-normalization';

describe('normalizeRow', () => {
  it('preserves and normalizes a CSV column named __proto__', () => {
    const row: EngineRow = Object.fromEntries([
      [csvInternalRowIdField, 'row-1'],
      ['__proto__', 42n],
    ]);

    const normalized = normalizeRow(row);

    expect(Object.getOwnPropertyDescriptor(normalized, '__proto__')?.value).toBe('42');
  });
});
