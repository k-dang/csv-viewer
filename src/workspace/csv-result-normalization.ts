import type { CsvCellValue, CsvRow } from '../shared/csv-viewer-contract';
import { csvInternalRowIdField } from '../shared/csv-viewer-contract';

export type EngineCellValue =
  | null
  | boolean
  | number
  | bigint
  | string
  | Uint8Array
  | Date
  | EngineCellValue[]
  | { [key: string]: EngineCellValue };

export type EngineRow = Record<string, EngineCellValue>;

/**
 * Turns engine result values into the workspace's own representation, so no engine's type
 * quirks reach domain code.
 */
export function normalizeCellValue(value: EngineCellValue | undefined): CsvCellValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

export function normalizeRow(row: EngineRow): CsvRow {
  const normalizedRow: Record<string, CsvCellValue> = {};
  for (const [key, value] of Object.entries(row)) {
    normalizedRow[key] = normalizeCellValue(value);
  }
  const rowId = normalizedRow[csvInternalRowIdField];

  if (!rowId) {
    throw new Error('CSV row is missing its internal row identifier.');
  }

  return { ...normalizedRow, [csvInternalRowIdField]: rowId };
}

export function normalizeCount(value: EngineCellValue | undefined): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('The data engine returned an invalid non-negative count.');
  }
  return count;
}
