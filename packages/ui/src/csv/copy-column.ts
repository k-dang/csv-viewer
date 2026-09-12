import { toast } from '@/components/ui/toast';
import { formatNumber } from './csv-format';
import type { CsvTab } from './csv-tab';

/** Confirms a completed clipboard write for both the button and the grid shortcut. */
export async function copyColumn(tab: CsvTab): Promise<void> {
  const result = await tab.copyFocusedColumn();
  if (!result) return;
  toast.add({
    title: `Copied ${formatNumber(result.count)} ${result.count === 1 ? 'value' : 'values'}`,
    description: `From ${result.column}`,
    type: 'success',
  });
}
