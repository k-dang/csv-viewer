import { Effect, Schema } from 'effect';
import { describe, expect, it } from '@effect/vitest';
import { csvInternalRowIdField } from '../csv-viewer';
import { decodeEngineRow, decodeEngineRows, EngineCsvRow, EngineNonNegativeInt, normalizeRow, type EngineRow } from './csv-result-normalization';

const decodeCsvRows = decodeEngineRows(EngineCsvRow);
const decodeCount = decodeEngineRow(Schema.Struct({ count: EngineNonNegativeInt }));

describe('engine row decoding', () => {
  it.effect('preserves and normalizes a CSV column named __proto__', () => Effect.gen(function* () {
    const [row] = yield* decodeCsvRows([Object.fromEntries([
      [csvInternalRowIdField, 'row-1'],
      ['__proto__', 42n],
    ])]);

    const normalized = normalizeRow(row);

    expect(Object.getOwnPropertyDescriptor(normalized, '__proto__')?.value).toBe('42');
    expect(normalized[csvInternalRowIdField]).toBe('row-1');
  }));

  it.effect('fails a row without its internal identifier as DataEngineError', () => Effect.gen(function* () {
    const failure = yield* Effect.flip(decodeCsvRows([{ name: 'Ada' }]));

    expect(failure._tag).toBe('DataEngineError');
    expect(failure.message).toBe('The data engine could not complete the operation.');
  }));

  it.effect('fails a non-text row identifier as DataEngineError', () => Effect.gen(function* () {
    const failure = yield* Effect.flip(decodeCsvRows([{ [csvInternalRowIdField]: 1n, name: 'Ada' }]));

    expect(failure._tag).toBe('DataEngineError');
  }));

  it.effect('decodes BIGINT and INTEGER counts to numbers', () => Effect.gen(function* () {
    expect(yield* decodeCount([{ count: 12n }])).toEqual({ count: 12 });
    expect(yield* decodeCount([{ count: 7 }])).toEqual({ count: 7 });
  }));

  it.effect.each<readonly [string, EngineRow[]]>([
    ['a negative count', [{ count: -1n }]],
    ['an unsafe count', [{ count: 2n ** 60n }]],
    ['a text count', [{ count: '3' }]],
    ['a missing aggregate row', []],
    ['an extra aggregate row', [{ count: 1n }, { count: 2n }]],
  ])('fails %s as DataEngineError', ([, rows]) => Effect.gen(function* () {
    const failure = yield* Effect.flip(decodeCount(rows));

    expect(failure._tag).toBe('DataEngineError');
  }));
});
