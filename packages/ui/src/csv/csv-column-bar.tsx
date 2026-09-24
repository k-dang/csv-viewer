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

  // Drop a finished F2 once focus leaves that column, so undo or a later return does not reopen the field.
  if (headerRename && headerRename.column !== focusedColumn) setHeaderRename(null);
  const f2Rename = headerRename?.column === focusedColumn ? headerRename : null;

  return (
    <div ref={bindKeys} className="flex min-h-11 items-center gap-3 border-b bg-muted/40 px-[18px] py-1.5 text-sm">
      <FocusedColumnBar
        tab={tab}
        focusedColumn={focusedColumn}
        filteredRowCount={filteredRowCount}
        columnCount={workingCsv.columns.length}
        f2Rename={f2Rename}
      />
    </div>
  );
}

function FocusedColumnBar({
  tab,
  focusedColumn,
  filteredRowCount,
  columnCount,
  f2Rename,
}: {
  tab: CsvTab;
  focusedColumn: string | null;
  filteredRowCount: number;
  columnCount: number;
  f2Rename: { column: string; serial: number } | null;
}) {
  const [trackedColumn, setTrackedColumn] = useState(focusedColumn);
  const [seenF2Serial, setSeenF2Serial] = useState<number | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(focusedColumn ?? '');
  if (trackedColumn !== focusedColumn) {
    setTrackedColumn(focusedColumn);
    setSeenF2Serial(f2Rename?.serial ?? null);
    setRenaming(f2Rename !== null);
    setDraft(f2Rename?.column ?? focusedColumn ?? '');
  } else if (f2Rename && seenF2Serial !== f2Rename.serial) {
    setSeenF2Serial(f2Rename.serial);
    setDraft(f2Rename.column);
    setRenaming(true);
  }

  async function commitRename(): Promise<void> {
    const ok = await tab.renameFocusedColumn(draft);
    if (ok) setRenaming(false);
  }

  const actionsDisabled = focusedColumn === null;

  return (
    <>
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {focusedColumn && renaming ? (
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
              key={f2Rename?.serial ?? 0}
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
          <span className={focusedColumn ? 'truncate font-semibold text-foreground' : 'text-muted-foreground'}>
            {focusedColumn ?? 'Select a cell to copy its column.'}
          </span>
        )}
        {focusedColumn ? (
          <span className="shrink-0 text-muted-foreground">{formatNumber(filteredRowCount)} values</span>
        ) : null}
      </div>
      <div className="ml-auto flex shrink-0 items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          title="Rename column (F2 on the column header)"
          aria-pressed={renaming}
          disabled={actionsDisabled}
          onClick={() => {
            if (!focusedColumn) return;
            if (renaming) {
              setRenaming(false);
              setDraft(focusedColumn);
              return;
            }
            setDraft(focusedColumn);
            setRenaming(true);
          }}
        >
          <Pencil data-icon="inline-start" />
          Rename column
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          title="Copy column (Ctrl+Shift+A on a cell)"
          disabled={actionsDisabled}
          onClick={() => void copyColumn(tab)}
        >
          <Copy data-icon="inline-start" />
          Copy column
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={actionsDisabled}
          onClick={() => void tab.insertColumn('before')}
        >
          <BetweenVerticalStart data-icon="inline-start" />
          Insert column left
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={actionsDisabled}
          onClick={() => void tab.insertColumn('after')}
        >
          <BetweenVerticalEnd data-icon="inline-start" />
          Insert column right
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={actionsDisabled || columnCount === 1}
          onClick={() => void tab.deleteFocusedColumn()}
        >
          <Trash2 data-icon="inline-start" />
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
