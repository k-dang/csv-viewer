import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { BetweenVerticalEnd, BetweenVerticalStart, Copy, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CsvTab } from './csv-tab';
import { formatNumber } from './csv-format';
import { copyColumn, isCopyColumnShortcut } from './copy-column';

/**
 * The strip between the toolbar and the row grid that names the focused column, renames it, and copies it.
 * F2 starts rename only while a Working CSV column header has keyboard focus. Focus on a cell, the
 * search box, or any other control leaves F2 to that control, so the grid can still edit a cell.
 * Ctrl+Shift+A copies the focused column from anywhere that is not a text field.
 */
export function CsvColumnBar({ tab, active }: { tab: CsvTab; active: boolean }) {
  const { focusedColumn, filteredRowCount, workingCsv } = useSyncExternalStore(tab.subscribe, tab.snapshot);
  const [headerRename, setHeaderRename] = useState<{ column: string; serial: number } | null>(null);
  // Drop a finished F2 once focus leaves that column, so undo or a later return does not reopen the field.
  if (headerRename && headerRename.column !== focusedColumn) setHeaderRename(null);

  const onKeyDownRef = useRef<(event: KeyboardEvent, capture: boolean) => void>(() => {});
  onKeyDownRef.current = (event, capture) => {
    if (!active) return;
    if (capture) {
      const column = headerColumnForF2(event, tab);
      if (!column) return;
      event.preventDefault();
      event.stopPropagation();
      tab.setFocusedColumn(column);
      setHeaderRename((current) => ({ column, serial: (current?.serial ?? 0) + 1 }));
      return;
    }
    // Bubble, not capture: text fields keep their own keystrokes, and cell F2 still edits.
    if (!focusedColumn || !isCopyColumnShortcut(event) || isTextField(event.target)) return;
    event.preventDefault();
    void copyColumn(tab);
  };
  const bindKeys = useCallback((node: HTMLDivElement | null) => {
    if (!node) return;
    const onCopy = (event: KeyboardEvent) => onKeyDownRef.current(event, false);
    const onHeaderRename = (event: KeyboardEvent) => onKeyDownRef.current(event, true);
    window.addEventListener('keydown', onCopy);
    window.addEventListener('keydown', onHeaderRename, true);
    return () => {
      window.removeEventListener('keydown', onCopy);
      window.removeEventListener('keydown', onHeaderRename, true);
    };
  }, []);

  const f2Rename = headerRename?.column === focusedColumn ? headerRename : null;

  return (
    <div ref={bindKeys} className="flex min-h-11 items-center gap-3 border-b bg-muted/40 px-[18px] py-1.5 text-sm">
      {focusedColumn ? (
        <FocusedColumnBar
          key={f2Rename ? `header-rename:${f2Rename.serial}:${focusedColumn}` : `focused-column:${focusedColumn}`}
          tab={tab}
          focusedColumn={focusedColumn}
          filteredRowCount={filteredRowCount}
          columnCount={workingCsv.columns.length}
          initialRenaming={f2Rename !== null}
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
  columnCount,
  initialRenaming,
}: {
  tab: CsvTab;
  focusedColumn: string;
  filteredRowCount: number;
  columnCount: number;
  initialRenaming: boolean;
}) {
  const [renaming, setRenaming] = useState(initialRenaming);
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
          title="Rename column (F2 on the column header)"
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
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void tab.insertColumn('before')}
        >
          <BetweenVerticalStart />
          Insert column left
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void tab.insertColumn('after')}
        >
          <BetweenVerticalEnd />
          Insert column right
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={columnCount === 1}
          onClick={() => void tab.deleteFocusedColumn()}
        >
          <Trash2 />
          Delete column
        </Button>
      </div>
    </>
  );
}

function isTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select') !== null);
}

/** The Working CSV column whose header is the key target, or null when F2 should be left alone. */
function headerColumnForF2(event: KeyboardEvent, tab: CsvTab): string | null {
  if (event.key !== 'F2' || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return null;
  }
  if (!(event.target instanceof Element) || isTextField(event.target)) return null;
  const header = event.target.closest('.ag-header-cell');
  if (!(header instanceof HTMLElement)) return null;
  const colId = header.getAttribute('col-id');
  if (!colId) return null;
  const known = tab.snapshot().workingCsv.columns.some((column) => column.name === colId);
  return known ? colId : null;
}
