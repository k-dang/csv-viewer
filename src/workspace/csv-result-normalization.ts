import type { CsvCellValue, CsvRow } from '../shared/ipc';
import { csvInternalRowIdField } from '../shared/ipc';

/**
 * Turns engine result values into the workspace's own representation, so no engine's type
 * quirks reach domain code.
 */
export function normalizeCellValue(value: unknown): CsvCellValue {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return value.toISOString();
  return typeof value === 'string' ? value : String(value);
}

export function normalizeRow(row: Record<string, unknown>): CsvRow {
  const normalizedRow = Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeCellValue(value)]),
  );
  const rowId = normalizedRow[csvInternalRowIdField];

  if (typeof rowId !== 'string' || rowId.length === 0) {
    throw new Error('CSV row is missing its internal row identifier.');
  }

  return normalizedRow as CsvRow;
}

export function normalizeCount(value: unknown): number {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error('The data engine returned an invalid non-negative count.');
  }
  return count;
}
