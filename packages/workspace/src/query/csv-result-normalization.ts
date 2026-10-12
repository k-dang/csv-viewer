import { Effect, Schema, SchemaTransformation } from 'effect';
import type { CsvCellValue, CsvRow } from '../csv-viewer';
import { csvInternalRowIdField } from '../csv-viewer';
import { DataEngineError } from '../database';

// A row as the engine returns it. Values are unchecked until one of the decoders below accepts them.
// oxlint-disable-next-line anti-slop/no-unsafe-dictionary-type
export type EngineRow = { readonly [column: string]: unknown };

/**
 * One scalar result value. Working CSV tables hold VARCHAR cells and no query selects nested
 * values, so a list, struct, or invalid Date fails decoding rather than becoming an object.
 */
export const EngineCell = Schema.Union([
  Schema.Null,
  Schema.Boolean,
  Schema.Number,
  Schema.BigInt,
  Schema.String,
  Schema.Uint8Array,
  Schema.Date,
]);

export type EngineCellValue = typeof EngineCell.Type;

/** A BIGINT or INTEGER result, which drivers return as either a bigint or a number. */
export const EngineNonNegativeInt = Schema.Union([Schema.Number, Schema.BigInt]).pipe(Schema.decodeTo(
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER)),
  SchemaTransformation.transform<number, number | bigint>({ decode: Number, encode: (count) => count }),
));

export const EngineRowId = Schema.NonEmptyString;

export const EngineCellRow = Schema.Record(Schema.String, EngineCell);

/** A Working CSV row: its internal identifier plus one engine value per projected column. */
export const EngineCsvRow = Schema.StructWithRest(
  Schema.Struct({ [csvInternalRowIdField]: EngineRowId }),
  [Schema.Record(Schema.String, EngineCell)],
);

/**
 * Decodes one result set at the point the engine returns it. A row that does not match fails
 * as DataEngineError, so a malformed result reaches the user as an engine failure, not a defect.
 */
export function decodeEngineRows<S extends Schema.Decoder<unknown>>(row: S) {
  const decode = Schema.decodeUnknownEffect(Schema.Array(row));
  return (rows: readonly EngineRow[]): Effect.Effect<ReadonlyArray<S['Type']>, DataEngineError> =>
    decode(rows).pipe(Effect.mapError((cause) => new DataEngineError({ cause })));
}

export const decodeEngineCellRows = decodeEngineRows(EngineCellRow);

/** Decodes a result set that must hold exactly one row, such as an aggregate. */
export function decodeEngineRow<S extends Schema.Decoder<unknown>>(row: S) {
  const decode = Schema.decodeUnknownEffect(Schema.Tuple([row]));
  return (rows: readonly EngineRow[]): Effect.Effect<S['Type'], DataEngineError> =>
    decode(rows).pipe(
      Effect.map(([decoded]) => decoded),
      Effect.mapError((cause) => new DataEngineError({ cause })),
    );
}

/**
 * Turns engine result values into the workspace's own representation, so no engine's type
 * quirks reach domain code.
 */
export function normalizeCellValue(value: EngineCellValue | undefined): CsvCellValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function normalizeRow(row: typeof EngineCsvRow.Type): CsvRow {
  const normalizedRow: Record<string, CsvCellValue> = Object.create(null);
  for (const [key, value] of Object.entries(row)) {
    normalizedRow[key] = normalizeCellValue(value);
  }
  return { ...normalizedRow, [csvInternalRowIdField]: row[csvInternalRowIdField] };
}
