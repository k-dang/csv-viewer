import type { CsvCellValue } from '../../shared/ipc';

export function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}

export function formatCellValue(value: CsvCellValue | undefined): string {
  if (value === undefined) {
    return '';
  }

  if (value === null) {
    return '[null]';
  }

  if (value === '') {
    return '[empty]';
  }

  return String(value);
}
