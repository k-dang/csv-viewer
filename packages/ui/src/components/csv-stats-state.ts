import type { CsvColumn } from '@csv-viewer/workspace/csv-viewer';

export function resolveStatsColumnOnOpen({
  columns,
  currentColumn,
  focusedColumn,
}: {
  columns: CsvColumn[];
  currentColumn: string;
  focusedColumn: string | null;
}): string {
  const fallbackColumn = columns[0]?.name ?? '';
  const candidate = focusedColumn ?? currentColumn ?? fallbackColumn;

  return columns.some((column) => column.name === candidate) ? candidate : fallbackColumn;
}
