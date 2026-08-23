import type { CsvDialectOptions } from '../../shared/csv-viewer-contract';

export type CsvHeaderMode = 'auto' | 'yes' | 'no';

export function buildDialectOptions(
  delimiter: string,
  headerMode: CsvHeaderMode,
): CsvDialectOptions | string {
  const normalizedDelimiter = delimiter.trim();

  if (normalizedDelimiter.length > 1) {
    return 'Delimiter must be one character, or blank for automatic detection.';
  }

  return {
    ...(normalizedDelimiter ? { delimiter: normalizedDelimiter } : {}),
    ...(headerMode === 'auto' ? {} : { header: headerMode === 'yes' }),
  };
}
