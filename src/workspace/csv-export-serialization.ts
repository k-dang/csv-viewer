import type { CsvColumn } from '../shared/ipc';
import { normalizeCellValue } from './csv-result-normalization';

/**
 * Serializes Working CSV rows to exported CSV text. Export serialization stays in shared
 * JavaScript rather than an engine `COPY TO`, so exported bytes are identical across runtimes.
 * Engine values are normalized cell by cell here, so no intermediate copy of the rows is built.
 */
export function serializeCsvExport({
  columns,
  rows,
  delimiter,
  header,
}: {
  columns: CsvColumn[];
  rows: Array<Record<string, unknown>>;
  delimiter: string;
  header: boolean;
}): string {
  const lines: string[] = [];

  if (header) {
    lines.push(columns.map((column) => serializeField(column.name, delimiter)).join(delimiter));
  }

  for (const row of rows) {
    lines.push(
      columns
        .map((column) => serializeField(normalizeCellValue(row[column.name]) ?? '', delimiter))
        .join(delimiter),
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
