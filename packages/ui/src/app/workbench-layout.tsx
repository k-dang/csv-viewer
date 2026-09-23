import { useState, type ReactNode, type Ref } from 'react';
import { Keyboard, PanelLeftClose, PanelLeftOpen, Table2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';
import { cn } from '@/lib/utils';
import type { DialectControlsProps } from '@/csv/dialect-controls';
import { AppearanceControls, OpenCsvControl, type AppearanceProps, type OpenCsvAction } from './chrome-controls';
import { TabStrip, type TabStripProps } from './tab-strip';
import { getInitialSidebarCollapsed, saveSidebarCollapsed } from './theme';

/**
 * The app shell: a `Workspace` sidebar with Open CSV, the open Files and Comparisons, the
 * appearance controls, and the keyboard shortcuts button, beside the active Tab's content (`children`). The sidebar collapses to an
 * icon rail and remembers that choice.
 */
export function WorkbenchLayout({
  shellRef,
  onToggleShortcuts,
  open,
  dialect,
  appearance,
  tabs,
  openError,
  children,
}: {
  /** Bound to the shell's `<main>`; App attaches its window listeners through it. */
  shellRef: Ref<HTMLElement>;
  onToggleShortcuts: () => void;
  open: OpenCsvAction;
  dialect: DialectControlsProps;
  appearance: AppearanceProps;
  tabs: TabStripProps;
  openError: string | null;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(getInitialSidebarCollapsed);
  const csvTabs = tabs.tabs.filter((tab) => tab.kind === 'csv');
  const comparisonTabs = tabs.tabs.filter((tab) => tab.kind === 'comparison');

  function toggleCollapsed() {
    saveSidebarCollapsed(!collapsed);
    setCollapsed(!collapsed);
  }

  return (
    <main
      ref={shellRef}
      className={cn(
        'app-shell grid h-screen min-w-[720px]',
        collapsed ? 'grid-cols-[52px_minmax(0,1fr)]' : 'grid-cols-[236px_minmax(0,1fr)]',
      )}
    >
      <nav
        aria-label="Workspace"
        data-collapsed={collapsed ? '' : undefined}
        className="group/sidebar flex min-h-0 flex-col border-r bg-card/60"
      >
        <div className="flex h-12 shrink-0 items-center gap-2.5 px-3.5">
          <div
            className="grid size-7 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground"
            aria-hidden="true"
          >
            <Table2 className="size-4" />
          </div>
          <h1 className="truncate text-base font-semibold tracking-tight text-foreground group-data-collapsed/sidebar:sr-only">
            CSV Viewer
          </h1>
        </div>
        <div className="px-2">
          <OpenCsvControl action={open} dialect={dialect} compact={collapsed} className="w-full" />
        </div>
        <div className="mt-4 flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-2 pb-2">
          <section className="grid gap-1">
            <SidebarHeading>Files</SidebarHeading>
            {csvTabs.length > 0 ? (
              <TabStrip {...tabs} tabs={csvTabs} label="Open CSV Tabs" />
            ) : (
              <p className="px-2 text-sm text-muted-foreground group-data-collapsed/sidebar:hidden">No files open.</p>
            )}
          </section>
          {comparisonTabs.length > 0 ? (
            <section className="grid gap-1">
              <SidebarHeading>Comparisons</SidebarHeading>
              <TabStrip {...tabs} tabs={comparisonTabs} label="Comparison Tabs" />
            </section>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1 border-t p-2 group-data-collapsed/sidebar:flex-col">
          <AppearanceControls {...appearance} className="group-data-collapsed/sidebar:flex-col" />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={onToggleShortcuts}
            title="Keyboard shortcuts"
            aria-label="Keyboard shortcuts"
          >
            <Keyboard />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="ml-auto group-data-collapsed/sidebar:ml-0"
            onClick={toggleCollapsed}
            title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
            aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          >
            {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          </Button>
        </div>
      </nav>
      <div className="grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)]">
        <div>
          {tabs.tabs.length > 0 && openError ? (
            <FieldError className="max-h-40 overflow-auto border-b border-destructive/30 bg-destructive/10 px-4 py-2 font-semibold break-words whitespace-pre-line">
              {openError}
            </FieldError>
          ) : null}
        </div>
        {children}
      </div>
    </main>
  );
}

function SidebarHeading({ children }: { children: ReactNode }) {
  return (
    <p className="px-2 text-[11px] font-semibold tracking-wider text-muted-foreground uppercase group-data-collapsed/sidebar:sr-only">
      {children}
    </p>
  );
}
