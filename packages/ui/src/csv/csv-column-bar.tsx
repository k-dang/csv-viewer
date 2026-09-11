import { useEffect, useState, useSyncExternalStore } from 'react';
import { Check, Copy } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { CsvTab } from './csv-tab';
import { formatNumber } from './csv-format';

const copiedNoticeMs = 2500;

/**
 * The strip between the toolbar and the row grid that names the focused column and copies it.
 * The row grid highlights the same column, so the copy target is visible before the click.
 */
export function CsvColumnBar({ tab }: { tab: CsvTab }) {
  const { focusedColumn, filteredRowCount } = useSyncExternalStore(tab.subscribe, tab.snapshot);
  const [copied, setCopied] = useState<{ column: string; count: number } | null>(null);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), copiedNoticeMs);
    return () => clearTimeout(timer);
  }, [copied]);

  async function copy(column: string) {
    const count = await tab.copyFocusedColumn();
    if (count !== null) setCopied({ column, count });
  }

  if (!focusedColumn) {
    return (
      <div className="border-b bg-muted/40 px-[18px] py-2 text-sm text-muted-foreground">
        Select a cell to copy its column.
      </div>
    );
  }

  // A notice for another column is stale the moment focus moves.
  const notice = copied?.column === focusedColumn ? copied : null;

  return (
    <div className="flex items-center gap-3 border-b bg-muted/40 px-[18px] py-2">
      <span className="truncate text-sm font-semibold text-foreground">{focusedColumn}</span>
      <span className="shrink-0 text-sm text-muted-foreground">{formatNumber(filteredRowCount)} values</span>
      {notice ? (
        <span className="shrink-0 text-sm text-primary" role="status">
          Copied {formatNumber(notice.count)}
        </span>
      ) : null}
      <Button type="button" variant="outline" size="sm" className="ml-auto" onClick={() => void copy(focusedColumn)}>
        {notice ? <Check /> : <Copy />}
        Copy column
      </Button>
    </div>
  );
}
