import { useSyncExternalStore } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { CsvTab } from './csv-tab';
import { formatNumber } from './csv-format';

/**
 * The strip between the toolbar and the row grid that names the focused column and copies it.
 * The row grid highlights the same column, so the copy target is visible before the click, and
 * Ctrl+C on a focused cell runs the same Tab command.
 */
export function CsvColumnBar({ tab }: { tab: CsvTab }) {
  const { focusedColumn, filteredRowCount, copiedColumn } = useSyncExternalStore(tab.subscribe, tab.snapshot);

  if (!focusedColumn) {
    return (
      <div className="border-b bg-muted/40 px-[18px] py-2 text-sm text-muted-foreground">
        Select a cell to copy its column.
      </div>
    );
  }

  return (
    <div className="flex items-center gap-3 border-b bg-muted/40 px-[18px] py-2">
      <span className="truncate text-sm font-semibold text-foreground">{focusedColumn}</span>
      <span className="shrink-0 text-sm text-muted-foreground">{formatNumber(filteredRowCount)} values</span>
      {copiedColumn ? (
        <span className="shrink-0 text-sm text-primary" role="status">
          Copied {formatNumber(copiedColumn.count)}
        </span>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="ml-auto"
        title="Copy column (Ctrl+C on a cell)"
        onClick={() => void tab.copyFocusedColumn()}
      >
        {copiedColumn ? <Check /> : <Copy />}
        Copy column
      </Button>
    </div>
  );
}
