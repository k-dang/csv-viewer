import type { CsvCellValue, CsvColumn } from '../shared/ipc';

/**
 * Serializes Working CSV rows to exported CSV text. Export serialization stays in shared
 * JavaScript rather than an engine `COPY TO`, so exported bytes are identical across runtimes.
 */
export function serializeCsvExport({
  columns,
  rows,
  delimiter,
  header,
}: {
  columns: CsvColumn[];
  rows: Array<Record<string, CsvCellValue>>;
  delimiter: string;
  header: boolean;
}): string {
  const lines: string[] = [];

  if (header) {
    lines.push(columns.map((column) => serializeField(column.name, delimiter)).join(delimiter));
  }

  for (const row of rows) {
    lines.push(
      columns.map((column) => serializeField(row[column.name] ?? '', delimiter)).join(delimiter),
    );
  }

  return `${lines.join('\n')}${lines.length > 0 ? '\n' : ''}`;
}

function serializeField(value: string, delimiter: string): string {
  if (
    value.includes('"') ||
    value.includes('\n') ||
    value.includes('\r') ||
    value.includes(delimiter)
  ) {
    return `"${value.replaceAll('"', '""')}"`;
  }

  return value;
}
