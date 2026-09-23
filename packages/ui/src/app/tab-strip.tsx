import { useSyncExternalStore, type ReactNode } from 'react';
import { ArrowLeftRight, FileSpreadsheet, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import type { RendererTab } from './renderer-workspace';

export type TabStripProps = {
  tabs: RendererTab[];
  activeTabId: string | null;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tab: RendererTab) => void;
};

/**
 * A vertical list of Tabs for the Workbench sidebar. In a collapsed sidebar
 * (`group/sidebar` with `data-collapsed`) only each Tab's icon and badge stay visible.
 */
export function TabStrip({ tabs, activeTabId, onSelectTab, onCloseTab, label }: TabStripProps & { label: string }) {
  return (
    <Tabs value={activeTabId ?? undefined} onValueChange={onSelectTab} orientation="vertical" className="min-h-0 min-w-0 gap-0">
      <TabsList
        aria-label={label}
        variant="line"
        className="h-auto w-full min-w-0 flex-col items-stretch gap-0.5 rounded-none p-0"
      >
        {tabs.map((tab) =>
          tab.kind === 'csv' ? (
            <CsvTabItem key={tab.id} tab={tab} isActive={tab.id === activeTabId} onClose={() => onCloseTab(tab)} />
          ) : (
            <ComparisonTabItem key={tab.id} tab={tab} isActive={tab.id === activeTabId} onClose={() => onCloseTab(tab)} />
          ),
        )}
      </TabsList>
    </Tabs>
  );
}

/** Each item subscribes to its own Tab, so a change re-renders one label rather than the whole strip. */
function CsvTabItem({
  tab,
  isActive,
  onClose,
}: {
  tab: Extract<RendererTab, { kind: 'csv' }>;
  isActive: boolean;
  onClose: () => void;
}) {
  const state = useSyncExternalStore(tab.tab.subscribe, tab.tab.snapshot);
  return (
    <TabItem
      id={tab.id}
      label={state.workingCsv.source.name}
      title={state.workingCsv.source.location}
      icon={<FileSpreadsheet className="size-3.5 shrink-0" aria-hidden="true" />}
      isActive={isActive}
      onClose={onClose}
      badge={
        state.editState.hasUnexportedChanges ? (
          <Badge role="img" variant="secondary" className="size-1.5 shrink-0 rounded-full p-0" aria-label="Unexported Changes" />
        ) : null
      }
    />
  );
}

function ComparisonTabItem({
  tab,
  isActive,
  onClose,
}: {
  tab: Extract<RendererTab, { kind: 'comparison' }>;
  isActive: boolean;
  onClose: () => void;
}) {
  const comparison = useSyncExternalStore(tab.tab.subscribe, () => tab.tab.snapshot().comparison);
  const label = `${comparison.baseline.source.name} ⇄ ${comparison.candidate.source.name}`;
  return (
    <TabItem
      id={tab.id}
      label={label}
      title={label}
      isActive={isActive}
      onClose={onClose}
      icon={<ArrowLeftRight className="size-3.5 shrink-0" aria-hidden="true" />}
      badge={
        comparison.applied?.freshness.kind === 'outdated' ? (
          <Badge role="img" className="size-1.5 shrink-0 rounded-full bg-amber-500 p-0" aria-label="Outdated comparison" />
        ) : null
      }
    />
  );
}

function TabItem({
  id,
  label,
  title,
  isActive,
  icon,
  badge,
  onClose,
}: {
  id: string;
  label: string;
  title: string;
  isActive: boolean;
  icon?: ReactNode;
  badge: ReactNode;
  onClose: () => void;
}) {
  return (
    <div
      title={title}
      className={cn(
        'group flex w-full items-center rounded-md',
        isActive ? 'bg-accent text-accent-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <TabsTrigger
        value={id}
        className="min-w-0 flex-1 justify-start rounded-none border-0 bg-transparent px-3 py-1.5 shadow-none after:hidden data-active:bg-transparent data-active:shadow-none"
      >
        {icon}
        <span className="truncate group-data-collapsed/sidebar:sr-only">{label}</span>
        {badge}
      </TabsTrigger>
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={`Close ${label}`}
        className={cn(
          'mr-1 shrink-0 group-data-collapsed/sidebar:hidden',
          isActive ? '' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100',
        )}
        onClick={onClose}
      >
        <X className="size-3.5" />
      </Button>
    </div>
  );
}
