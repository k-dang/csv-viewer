import { useSyncExternalStore } from 'react';
import { Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { CsvTab } from './csv-tab';
import { formatNumber } from './csv-format';
import { copyColumn } from './copy-column';

/**
 * The strip between the toolbar and the row grid that names the focused column and copies it.
 * The row grid highlights the same column, so the copy target is visible before the click, and
 * Ctrl+C on a focused cell runs the same Tab command.
 */
export function CsvColumnBar({ tab }: { tab: CsvTab }) {
  const { focusedColumn, filteredRowCount } = useSyncExternalStore(tab.subscribe, tab.snapshot);

  return (
    <div className="flex min-h-11 items-center gap-3 border-b bg-muted/40 px-[18px] py-1.5 text-sm">
      {focusedColumn ? (
        <>
          <span className="truncate font-semibold text-foreground">{focusedColumn}</span>
          <span className="shrink-0 text-muted-foreground">{formatNumber(filteredRowCount)} values</span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="ml-auto"
            title="Copy column (Ctrl+C on a cell)"
            onClick={() => void copyColumn(tab)}
          >
            <Copy />
            Copy column
          </Button>
        </>
      ) : (
        <span className="text-muted-foreground">Select a cell to copy its column.</span>
      )}
    </div>
  );
}
