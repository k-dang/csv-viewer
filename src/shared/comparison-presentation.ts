import type { ComparisonColumnsMode, ComparisonSummary, CsvColumn } from './ipc';

export function orderComparisonValueColumns(
  currentBaselineColumns: CsvColumn[],
  key: string[],
  changedColumns: ComparisonSummary['changedColumns'],
  mode: ComparisonColumnsMode,
): string[] {
  const keyNames = new Set(key);
  const snapshotNames = new Set(changedColumns.map((column) => column.name));
  const currentNames = currentBaselineColumns
    .map((column) => column.name)
    .filter((name) => !keyNames.has(name) && snapshotNames.has(name));
  const currentNameSet = new Set(currentNames);
  const csvOrder = [
    ...currentNames,
    ...changedColumns.map((column) => column.name).filter((name) => !currentNameSet.has(name)),
  ];
  if (mode === 'csv-order') return csvOrder;
  const changedCounts = new Map(
    changedColumns.map((column) => [column.name, column.changedRowCount]),
  );
  const csvIndexes = new Map(csvOrder.map((name, index) => [name, index]));
  return [...csvOrder].sort(
    (left, right) =>
      (changedCounts.get(right) ?? 0) - (changedCounts.get(left) ?? 0) ||
      (csvIndexes.get(left) ?? 0) - (csvIndexes.get(right) ?? 0),
  );
}
