import type { CsvDialectOptions } from '@csv-viewer/workspace/csv-viewer';

export type CsvHeaderMode = 'auto' | 'yes' | 'no';

export function isCsvHeaderMode(value: string): value is CsvHeaderMode {
  return value === 'auto' || value === 'yes' || value === 'no';
}

export function isDialectError(result: CsvDialectOptions | string): result is string {
  return Object.prototype.toString.call(result) === '[object String]';
}

export function buildDialectOptions(
  delimiter: string,
  headerMode: CsvHeaderMode,
): CsvDialectOptions | string {
  const normalizedDelimiter = delimiter.trim();

  if (normalizedDelimiter.length > 1) {
    return 'Delimiter must be one character, or blank for automatic detection.';
  }

  const options: CsvDialectOptions = {};
  if (normalizedDelimiter) options.delimiter = normalizedDelimiter;
  if (headerMode !== 'auto') options.header = headerMode === 'yes';
  return options;
}
