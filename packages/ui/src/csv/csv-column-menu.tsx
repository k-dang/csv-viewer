import { useCallback, useId, useRef, useState, useSyncExternalStore, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { BetweenVerticalEnd, BetweenVerticalStart, Copy, Pencil, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from '@/components/ui/context-menu';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent } from '@/components/ui/popover';
import type { CsvTab } from './csv-tab';
import { copyColumn, isCopyColumnShortcut } from './copy-column';

type ColumnHeader = { column: string; header: HTMLElement };

/**
 * The column header menu around the row grid. Right-click (or press the Menu key on) a Working CSV
 * column header to rename, copy, insert beside, or delete that column; right-clicks anywhere else
 * keep the browser's own menu. F2 on a focused header opens the same rename field under the
 * header, and Ctrl+Shift+A copies the focused column from anywhere that is not a text field.
 */
export function CsvColumnMenu({ tab, active, children }: { tab: CsvTab; active: boolean; children: ReactNode }) {
  const { focusedColumn, workingCsv } = useSyncExternalStore(tab.subscribe, tab.snapshot);
  const [menu, setMenu] = useState<(ColumnHeader & { point: DOMRect }) | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [rename, setRename] = useState<ColumnHeader | null>(null);
  // Drop a finished rename once focus leaves its column, so undo or a later return does not reopen it.
  if (rename && rename.column !== focusedColumn) setRename(null);
  // Rename opens its field only after the menu finishes closing; the closing click would dismiss it.
  // Cleared when the menu opens, not when it closes: the menu reads it on unmount to skip focus return.
  const renameAfterClose = useRef<ColumnHeader | null>(null);
  const [columnActionPending, setColumnActionPending] = useState(false);

  const onKeyDownRef = useRef<(event: KeyboardEvent, capture: boolean) => void>(() => {});
  onKeyDownRef.current = (event, capture) => {
    if (!active) return;
    if (capture) {
      const target = headerForF2(event, tab);
      if (!target) return;
      event.preventDefault();
      event.stopPropagation();
      if (columnActionPending) return;
      tab.setFocusedColumn(target.column);
      setRename(target);
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

  function onContextMenu(event: ReactMouseEvent) {
    const target = knownHeader(event.target, tab);
    if (!target) return;
    event.preventDefault();
    tab.setFocusedColumn(target.column);
    renameAfterClose.current = null;
    // Chromium reports the focused header's position for the Menu key, so both open at a point.
    setMenu({ ...target, point: DOMRect.fromRect({ x: event.clientX, y: event.clientY }) });
    setMenuOpen(true);
  }

  function runColumnAction(action: () => Promise<boolean>): void {
    setColumnActionPending(true);
    void action().finally(() => setColumnActionPending(false));
  }

  return (
    <div ref={bindKeys} className="contents" onContextMenu={onContextMenu}>
      {children}
      <ContextMenu
        open={menuOpen}
        onOpenChange={setMenuOpen}
        onOpenChangeComplete={(open) => {
          if (!open && renameAfterClose.current) setRename(renameAfterClose.current);
        }}
      >
        {menu ? (
          <ContextMenuContent
            anchor={{ getBoundingClientRect: () => menu.point }}
            aria-label={`Column ${menu.column}`}
            className="min-w-56"
            // Rename moves focus into its field; returning it to the header would send Enter to sort.
            finalFocus={() => renameAfterClose.current === null}
          >
            <ContextMenuItem
              disabled={columnActionPending}
              aria-keyshortcuts="F2"
              onClick={() => (renameAfterClose.current = { column: menu.column, header: menu.header })}
            >
              <Pencil />
              Rename column
              <ContextMenuShortcut aria-hidden="true" className="tracking-normal">F2</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuItem aria-keyshortcuts="Control+Shift+A Meta+Shift+A" onClick={() => void copyColumn(tab)}>
              <Copy />
              Copy column
              <ContextMenuShortcut aria-hidden="true" className="tracking-normal">Ctrl+Shift+A</ContextMenuShortcut>
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              disabled={columnActionPending}
              onClick={() => runColumnAction(() => tab.insertColumn('before'))}
            >
              <BetweenVerticalStart />
              Insert column left
            </ContextMenuItem>
            <ContextMenuItem
              disabled={columnActionPending}
              onClick={() => runColumnAction(() => tab.insertColumn('after'))}
            >
              <BetweenVerticalEnd />
              Insert column right
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem
              variant="destructive"
              disabled={columnActionPending || workingCsv.columns.length === 1}
              onClick={() => runColumnAction(() => tab.deleteFocusedColumn())}
            >
              <Trash2 />
              Delete column
            </ContextMenuItem>
          </ContextMenuContent>
        ) : null}
      </ContextMenu>
      <RenameColumnPopover key={rename?.column} tab={tab} target={rename} onClose={() => setRename(null)} />
    </div>
  );
}

/**
 * The Column name field, anchored under the header it renames. Enter commits; Escape cancels. A
 * rejected name keeps the field open with the reason beside it, far from the status bar's copy.
 */
function RenameColumnPopover({ tab, target, onClose }: { tab: CsvTab; target: ColumnHeader | null; onClose: () => void }) {
  const [draft, setDraft] = useState(target?.column ?? '');
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  async function commitRename(): Promise<void> {
    if (await tab.renameFocusedColumn(draft)) onClose();
    else setError(tab.snapshot().editError);
  }

  return (
    <Popover open={target !== null} onOpenChange={(open) => open || onClose()}>
      <PopoverContent anchor={target?.header} sideOffset={2} className="w-auto p-2">
        <form
          className="flex items-center gap-1.5"
          onSubmit={(event) => {
            event.preventDefault();
            void commitRename();
          }}
        >
          <Input
            aria-label="Column name"
            aria-invalid={error !== null}
            aria-describedby={error ? errorId : undefined}
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setError(null);
            }}
            onFocus={(event) => event.currentTarget.select()}
            className="h-7 w-48 px-2 text-xs"
            autoFocus
          />
          <Button type="submit" size="xs">
            Rename
          </Button>
        </form>
        {error ? (
          <p id={errorId} className="mt-1.5 text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function isTextField(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.isContentEditable || target.closest('input, textarea, select') !== null);
}

/** The Working CSV column header that contains `target`, or null for cells and unknown columns. */
function knownHeader(target: EventTarget | null, tab: CsvTab): ColumnHeader | null {
  if (!(target instanceof Element)) return null;
  const header = target.closest('.ag-header-cell');
  if (!(header instanceof HTMLElement)) return null;
  const column = header.getAttribute('col-id');
  if (!column) return null;
  const known = tab.snapshot().workingCsv.columns.some((candidate) => candidate.name === column);
  return known ? { column, header } : null;
}

/** The header F2 should rename, or null when F2 belongs to a cell, a text field, or a chord. */
function headerForF2(event: KeyboardEvent, tab: CsvTab): ColumnHeader | null {
  if (event.key !== 'F2' || event.repeat || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
    return null;
  }
  if (isTextField(event.target)) return null;
  return knownHeader(event.target, tab);
}
