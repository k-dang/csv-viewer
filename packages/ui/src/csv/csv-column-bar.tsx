import { useEffect, useState, useSyncExternalStore } from 'react';
import { Copy, Pencil } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CsvTab } from './csv-tab';
import { formatNumber } from './csv-format';
import { copyColumn, isCopyColumnShortcut } from './copy-column';

/**
 * The strip between the toolbar and the row grid that names the focused column and copies it.
 * The row grid highlights the same column, so the copy target is visible before the click, and
 * Ctrl+Shift+A anywhere in the window runs the same Tab command: the target is the focused column,
 * not whichever control has keyboard focus, so a click on a toast or button does not disarm it.
 */
export function CsvColumnBar({ tab, active }: { tab: CsvTab; active: boolean }) {
  const { focusedColumn, filteredRowCount } = useSyncExternalStore(tab.subscribe, tab.snapshot);

  // Text fields (global search, an open cell editor) keep their own keystrokes.
  useEffect(() => {
    if (!active || !focusedColumn) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isCopyColumnShortcut(event) || isTextField(event.target)) return;
      event.preventDefault();
      void copyColumn(tab);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [tab, active, focusedColumn]);

  return (
    <div className="flex min-h-11 items-center gap-3 border-b bg-muted/40 px-[18px] py-1.5 text-sm">
      {focusedColumn ? (
        <FocusedColumnBar
          key={focusedColumn}
          tab={tab}
          focusedColumn={focusedColumn}
          filteredRowCount={filteredRowCount}
        />
      ) : (
        <span className="text-muted-foreground">Select a cell to copy its column.</span>
      )}
    </div>
  );
}

function FocusedColumnBar({
  tab,
  focusedColumn,
  filteredRowCount,
}: {
  tab: CsvTab;
  focusedColumn: string;
  filteredRowCount: number;
}) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(focusedColumn);

  async function commitRename(): Promise<void> {
    const ok = await tab.renameFocusedColumn(draft);
    if (ok) setRenaming(false);
  }

  return (
    <>
      {renaming ? (
        <form
          className="flex min-w-0 flex-1 items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void commitRename();
          }}
        >
          <label className="sr-only" htmlFor="column-name">
            Column name
          </label>
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
        <span className="truncate font-semibold text-foreground">{focusedColumn}</span>
      )}
      <span className="shrink-0 text-muted-foreground">{formatNumber(filteredRowCount)} values</span>
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
          title="Copy column (Ctrl+Shift+A on a cell)"
          onClick={() => void copyColumn(tab)}
        >
          <Copy />
          Copy column
        </Button>
      </div>
    </>
  );
}

function isTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select') !== null);
}
