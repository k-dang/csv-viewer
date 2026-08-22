import { ArrowLeftRight, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import type { ComparisonView, WorkingCsvView } from '../../shared/csv-viewer-contract';

export type OpenRendererTab =
  | { kind: 'csv'; id: string; csv: WorkingCsvView }
  | { kind: 'comparison'; id: string; comparison: ComparisonView };

export function TabStrip({
  tabs,
  activeTabId,
  workingCsvIdsWithUnexportedChanges,
  onSelectTab,
  onCloseTab,
}: {
  tabs: OpenRendererTab[];
  activeTabId: string | null;
  workingCsvIdsWithUnexportedChanges: ReadonlySet<string>;
  onSelectTab: (tabId: string) => void;
  onCloseTab: (tab: OpenRendererTab) => void;
}) {
  return (
    <Tabs
      value={activeTabId ?? undefined}
      onValueChange={onSelectTab}
      className="gap-0 border-b bg-muted/40"
    >
      <TabsList
        aria-label="Open CSV and Comparison Tabs"
        variant="line"
        className="group-data-[orientation=horizontal]/tabs:h-auto max-w-full justify-start overflow-x-auto rounded-none px-3 pt-1.5 pb-0"
        onWheel={(event) => {
          if (event.deltaY !== 0) {
            event.currentTarget.scrollLeft += event.deltaY;
          }
        }}
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          const isCsv = tab.kind === 'csv';
          const label = isCsv
            ? tab.csv.file.name
            : `${tab.comparison.baseline.file.name} ⇄ ${tab.comparison.candidate.file.name}`;
          const hasUnexportedChanges =
            isCsv && workingCsvIdsWithUnexportedChanges.has(tab.csv.workingCsvId);
          const isOutdated = !isCsv && tab.comparison.applied?.freshness.kind === 'outdated';

          return (
            <div
              key={tab.id}
              title={isCsv ? tab.csv.file.location : label}
              className={cn(
                'group flex max-w-56 shrink-0 flex-none items-center rounded-t-md border border-b-0',
                isActive ? 'bg-background text-foreground' : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <TabsTrigger
                value={tab.id}
                className="min-w-0 flex-1 justify-start rounded-none border-0 bg-transparent px-3 py-1.5 shadow-none after:hidden data-[state=active]:bg-transparent data-[state=active]:shadow-none"
              >
                {!isCsv ? <ArrowLeftRight className="size-3.5 shrink-0" aria-hidden="true" /> : null}
                <span className="truncate">{label}</span>
                {hasUnexportedChanges ? (
                  <Badge
                    role="img"
                    variant="secondary"
                    className="size-1.5 shrink-0 rounded-full p-0"
                    aria-label="Unexported Changes"
                  />
                ) : null}
                {isOutdated ? (
                  <Badge
                    role="img"
                    className="size-1.5 shrink-0 rounded-full bg-amber-500 p-0"
                    aria-label="Outdated comparison"
                  />
                ) : null}
              </TabsTrigger>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Close ${label}`}
                className={cn('mr-1 shrink-0', isActive ? '' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100')}
                onClick={() => onCloseTab(tab)}
              >
                <X className="size-3.5" />
              </Button>
            </div>
          );
        })}
      </TabsList>
    </Tabs>
  );
}
