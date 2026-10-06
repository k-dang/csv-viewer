import { Copy, Filter, FilterX } from 'lucide-react';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from '@/components/ui/context-menu';
import { focusStillInMenu } from '@/lib/utils';
import type { CsvCellValue } from '@csv-viewer/workspace/csv-viewer';
import { copyCell } from './copy-column';
import { formatCellValue } from './csv-format';

/** A right-clicked text column cell, and where the click landed. */
export type CellMenuTarget = { column: string; value: CsvCellValue; point: DOMRect };

/**
 * The right-click menu on text column cells: copy the value, or keep or hide that exact value
 * through the column's Value Filter. The grid decides which cells open it.
 */
export function CsvCellMenu({
  target,
  open,
  onOpenChange,
  onFilter,
}: {
  target: CellMenuTarget | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** `keep` narrows the column to this value; otherwise the value is hidden. */
  onFilter: (target: CellMenuTarget, keep: boolean) => void;
}) {
  return (
    <ContextMenu open={open} onOpenChange={onOpenChange}>
      {target ? (
        <ContextMenuContent
          anchor={{ getBoundingClientRect: () => target.point }}
          aria-label={`Cell ${formatCellValue(target.value)}`}
          className="min-w-56"
          finalFocus={focusStillInMenu}
        >
          <ContextMenuItem aria-keyshortcuts="Control+C Meta+C" onClick={() => void copyCell(target.column, target.value)}>
            <Copy />
            Copy value
            <ContextMenuShortcut aria-hidden="true" className="tracking-normal">Ctrl+C</ContextMenuShortcut>
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem onClick={() => onFilter(target, true)}>
            <Filter />
            Filter to this value
          </ContextMenuItem>
          <ContextMenuItem onClick={() => onFilter(target, false)}>
            <FilterX />
            Exclude this value
          </ContextMenuItem>
        </ContextMenuContent>
      ) : null}
    </ContextMenu>
  );
}
