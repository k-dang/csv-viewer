import { useEffect, useState, useSyncExternalStore } from 'react';
import { Copy, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CsvTab } from './csv-tab';
import { formatNumber } from './csv-format';
import { copyColumn } from './copy-column';

/**
 * The strip between the toolbar and the row grid that names the focused column and copies it.
 * The row grid highlights the same column, so the copy target is visible before the click, and
 * Ctrl+C on a focused cell runs the same Tab command. Rename uses the same focused column.
 */
export function CsvColumnBar({ tab }: { tab: CsvTab }) {
  const { focusedColumn, filteredRowCount } = useSyncExternalStore(tab.subscribe, tab.snapshot);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState('');

  useEffect(() => {
    setRenaming(false);
    setDraft(focusedColumn ?? '');
  }, [focusedColumn]);

  async function commitRename(): Promise<void> {
    const ok = await tab.renameFocusedColumn(draft);
    if (ok) setRenaming(false);
  }

  return (
    <div className="flex min-h-11 items-center gap-3 border-b bg-muted/40 px-[18px] py-1.5 text-sm">
      {focusedColumn ? (
        <>
          {renaming ? (
            <form
              className="flex min-w-0 flex-1 items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void commitRename();
              }}
            >
              <Input
                id="column-name"
                aria-label="Column name"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Escape') {
                    event.preventDefault();
                    setRenaming(false);
                    setDraft(focusedColumn);
                  }
                }}
                className="h-8 max-w-xs"
                autoFocus
              />
            </form>
          ) : (
            <>
              <span className="truncate font-semibold text-foreground">{focusedColumn}</span>
              <span className="shrink-0 text-muted-foreground">{formatNumber(filteredRowCount)} values</span>
            </>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              title="Rename column"
              aria-pressed={renaming}
              onClick={() => {
                if (renaming) {
                  setRenaming(false);
                  setDraft(focusedColumn);
                  return;
                }
                setDraft(focusedColumn);
                setRenaming(true);
              }}
            >
              <Pencil />
              Rename column
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              title="Copy column (Ctrl+C on a cell)"
              onClick={() => void copyColumn(tab)}
            >
              <Copy />
              Copy column
            </Button>
          </div>
        </>
      ) : (
        <span className="text-muted-foreground">Select a cell to copy its column.</span>
      )}
    </div>
  );
}
