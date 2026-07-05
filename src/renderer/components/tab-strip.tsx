import { X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { cn } from '@/lib/utils';
import type { CsvSessionMetadata } from '../../shared/ipc';

export function TabStrip({
  tabs,
  activeSessionId,
  dirtySessionIds,
  onSelectTab,
  onCloseTab,
}: {
  tabs: CsvSessionMetadata[];
  activeSessionId: string | null;
  dirtySessionIds: ReadonlySet<string>;
  onSelectTab: (sessionId: string) => void;
  onCloseTab: (sessionId: string) => void;
}) {
  return (
    <Tabs
      value={activeSessionId ?? undefined}
      onValueChange={onSelectTab}
      className="gap-0 border-b bg-muted/40"
    >
      <TabsList
        aria-label="Open CSV files"
        variant="line"
        className="h-auto max-w-full justify-start overflow-x-auto rounded-none px-3 pt-1.5 pb-0"
        onWheel={(event) => {
          if (event.deltaY !== 0) {
            event.currentTarget.scrollLeft += event.deltaY;
          }
        }}
      >
        {tabs.map((session) => {
          const isActive = session.sessionId === activeSessionId;
          const isDirty = dirtySessionIds.has(session.sessionId);

          return (
            <div
              key={session.sessionId}
              title={session.file.path}
              className={cn(
                'group flex max-w-56 shrink-0 flex-none items-center rounded-t-md border border-b-0',
                isActive ? 'bg-background text-foreground' : 'bg-muted/60 text-muted-foreground hover:bg-muted hover:text-foreground',
              )}
            >
              <TabsTrigger
                value={session.sessionId}
                className="min-w-0 flex-1 justify-start rounded-none border-0 bg-transparent px-3 py-1.5 shadow-none after:hidden data-[state=active]:bg-transparent data-[state=active]:shadow-none"
              >
                <span className="truncate">{session.file.name}</span>
                {isDirty ? (
                  <Badge
                    variant="secondary"
                    className="size-1.5 shrink-0 rounded-full p-0"
                    aria-label="Unsaved changes"
                  />
                ) : null}
              </TabsTrigger>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Close ${session.file.name}`}
                className={cn('mr-1 shrink-0', isActive ? '' : 'opacity-0 focus-visible:opacity-100 group-hover:opacity-100')}
                onClick={() => onCloseTab(session.sessionId)}
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
