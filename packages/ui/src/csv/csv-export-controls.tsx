import { useState, useSyncExternalStore } from 'react';
import { Menu } from '@base-ui/react/menu';
import { ChevronDown, FileDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { CsvTab } from './csv-tab';
import { formatNumber } from './csv-format';

/** Complete export stays the default; the menu names the query result's scope. */
export function CsvExportControls({ tab, commitEditing, exportView }: {
  tab: CsvTab;
  commitEditing: () => Promise<boolean>;
  exportView: () => Promise<void>;
}) {
  const state = useSyncExternalStore(tab.subscribe, tab.snapshot);
  const [menuOpen, setMenuOpen] = useState(false);
  const countReady = state.queryStatus === 'ready';
  const explanation = !countReady ? 'Waiting for the current query'
    : state.filteredRowCount === 0 ? 'No matching rows to export' : null;
  return (
    <div className="flex items-center">
      <Button type="button" variant="outline" size="sm" className="rounded-r-none" disabled={state.exporting} onClick={() => void tab.export()} aria-label="Export CSV">
        <FileDown />Export
      </Button>
      <Menu.Root open={menuOpen} onOpenChange={(open) => {
        if (!open) setMenuOpen(false);
        else void commitEditing().then((accepted) => setMenuOpen(accepted));
      }}>
        <Menu.Trigger render={<Button variant="outline" size="icon-sm" className="-ml-px rounded-l-none" />} disabled={state.exporting} aria-label="Export options" title="Export options">
          <ChevronDown />
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner side="bottom" align="end" sideOffset={6} className="z-50">
            <Menu.Popup className="min-w-64 rounded-md border bg-popover p-1 text-popover-foreground shadow-md outline-none">
              <Menu.Item className="flex cursor-default items-center gap-2 rounded-sm px-3 py-2 text-sm outline-none data-highlighted:bg-accent data-disabled:opacity-50" disabled={state.exporting || !countReady || state.filteredRowCount === 0} onClick={() => void exportView()}>
                <FileDown className="size-4" />
                Export current view{countReady ? ` · ${formatNumber(state.filteredRowCount)} rows` : ''}
              </Menu.Item>
              {explanation ? <p className="px-3 pb-2 text-xs text-muted-foreground">{explanation}</p> : null}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}
