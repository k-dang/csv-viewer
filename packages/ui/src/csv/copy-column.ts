import type { CsvCellValue } from '@csv-viewer/workspace/csv-viewer';
import { toast } from '@/components/ui/toast';
import { formatNumber } from './csv-format';
import type { CsvTab } from './csv-tab';

/** Ctrl+C or Cmd+C with no other modifier. */
export function isCopyCellShortcut(event: Event): boolean {
  if (!(event instanceof KeyboardEvent)) return false;
  return event.key === 'c' && (event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey;
}

/** Ctrl+Shift+A or Cmd+Shift+A. */
export function isCopyColumnShortcut(event: Event): boolean {
  if (!(event instanceof KeyboardEvent)) return false;
  return event.key.toLowerCase() === 'a' && (event.ctrlKey || event.metaKey) && event.shiftKey && !event.altKey;
}

/** Confirms a completed clipboard write for both the button and the shortcut. */
export async function copyColumn(tab: CsvTab): Promise<void> {
  const result = await tab.copyFocusedColumn();
  if (result) confirmCopy(result.count, result.column);
}

/** Copies one cell's raw value (null as empty) and confirms it like the column copy. */
export async function copyCell(column: string, value: CsvCellValue | undefined): Promise<void> {
  try {
    await navigator.clipboard.writeText(String(value ?? ''));
    confirmCopy(1, column);
  } catch {
    toast.add({ title: 'Unable to copy cell.', type: 'error' });
  }
}

function confirmCopy(count: number, column: string): void {
  toast.add({
    title: `Copied ${formatNumber(count)} ${count === 1 ? 'value' : 'values'}`,
    description: `From ${column}`,
    type: 'success',
  });
}
