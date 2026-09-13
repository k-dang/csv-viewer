import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, ArrowLeftRight, FolderOpen, Loader2, Moon, RefreshCw, Sun, Table2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/toast';
import { FieldError } from '@/components/ui/field';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { ComparisonCandidateDialog } from '@/comparison/comparison-candidate-dialog';
import { ComparisonPanel } from '@/comparison/comparison-panel';
import { CsvGrid } from '@/csv/csv-grid';
import { DialectControls } from '@/csv/dialect-controls';
import { EmptyCsvState } from '@/csv/empty-csv-state';
import { TabStrip } from '@/app/tab-strip';
import type { ComparisonCandidate, WorkingCsvView } from '@csv-viewer/workspace/csv-viewer';
import type { RendererWorkspace } from './renderer-workspace';
import { useCsvViewer } from './csv-viewer';
import { applyTheme, getInitialTheme, type ThemeMode } from './theme';

export function App({ workspace }: { workspace: RendererWorkspace }) {
  const viewer = useCsvViewer();
  const workspaceState = useSyncExternalStore(workspace.subscribe, workspace.snapshot);
  const [candidatePicker, setCandidatePicker] = useState<{
    baseline: WorkingCsvView;
    candidates: ComparisonCandidate[];
  } | null>(null);
  const { delimiter, headerMode, dialectError } = workspaceState;
  const [themeMode, setThemeMode] = useState<ThemeMode>(getInitialTheme);

  const { tabs: openTabs, activeTabId, isOpening, error: openError, fatalError } = workspaceState;
  const csvTabs = openTabs.filter((tab) => tab.kind === 'csv');
  const comparisonTabs = openTabs.filter((tab) => tab.kind === 'comparison');
  const activeTab = openTabs.find((tab) => tab.id === activeTabId);
  const activeCsvTab = activeTab?.kind === 'csv' ? activeTab.tab : null;

  function toggleTheme() {
    const nextTheme = themeMode === 'dark' ? 'light' : 'dark';
    applyTheme(nextTheme);
    setThemeMode(nextTheme);
  }

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Tab' && event.ctrlKey) {
        event.preventDefault();
        workspace.cycle(event.shiftKey ? -1 : 1);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [workspace]);

  useEffect(() => {
    if (!viewer.capabilities.warnOnPageUnload) return;
    function warnBeforeUnload(event: BeforeUnloadEvent) {
      if (!workspace.hasUnexportedChanges()) return;
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [viewer.capabilities.warnOnPageUnload, workspace]);

  async function showCandidatePicker() {
    const candidates = await workspace.candidates();
    if (candidates) setCandidatePicker(candidates);
  }

  async function chooseCandidate(candidateId: string) {
    if (!candidatePicker) return;
    if (await workspace.openComparison(candidatePicker.baseline.workingCsvId, candidateId)) setCandidatePicker(null);
  }

  const closeCandidatePicker = useCallback(() => setCandidatePicker(null), []);

  const isDarkMode = themeMode === 'dark';
  const hasTabs = openTabs.length > 0;

  if (fatalError !== null) {
    return (
      <main className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
        <section
          className="grid w-full max-w-xl gap-5 rounded-xl border bg-card p-7 shadow-sm"
          role="alert"
        >
          <div
            className="grid size-11 place-items-center rounded-lg border border-destructive/20 bg-destructive/10 text-destructive"
            aria-hidden="true"
          >
            <AlertTriangle />
          </div>
          <div className="grid gap-2">
            <p className="text-xs font-bold uppercase text-muted-foreground">CSV Viewer Web</p>
            <h1 className="text-2xl font-semibold">The workspace stopped</h1>
            <p className="leading-relaxed text-muted-foreground">{fatalError}</p>
            <p className="text-sm leading-relaxed text-muted-foreground">
              Reload to start a new in-memory workspace. Select your CSV Sources again after reload.
            </p>
          </div>
          <Button type="button" className="w-fit" onClick={() => window.location.reload()}>
            Reload CSV Viewer
          </Button>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell grid min-h-screen min-w-0 grid-rows-[auto_1fr] md:min-w-[720px]">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b bg-card/92 px-4 py-2 backdrop-blur md:h-14 md:flex-nowrap md:py-0">
        <div className="flex min-w-0 items-center gap-2.5">
          <div
            className="grid size-8 shrink-0 place-items-center rounded-md bg-primary text-primary-foreground"
            aria-hidden="true"
          >
            <Table2 className="size-4" />
          </div>
          <h1 className="truncate text-base font-semibold tracking-tight text-foreground">CSV Viewer</h1>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 md:ml-auto">
          <DialectControls
            delimiter={delimiter}
            headerMode={headerMode}
            onDelimiterChange={(value) => workspace.updateDialect(value, headerMode)}
            onHeaderModeChange={(value) => workspace.updateDialect(delimiter, value)}
          />
          <Separator orientation="vertical" className="hidden md:my-1 md:block" />
          <Button type="button" size="sm" onClick={() => void workspace.open()} disabled={isOpening}>
            {isOpening ? <Loader2 className="animate-spin" /> : <FolderOpen />}
            {isOpening ? 'Opening...' : 'Open CSV'}
          </Button>
          {activeCsvTab ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void workspace.reopen()}
              disabled={isOpening}
            >
              <RefreshCw />
              Reopen
            </Button>
          ) : null}
          {activeCsvTab ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void showCandidatePicker()}
              disabled={csvTabs.length < 2}
            >
              <ArrowLeftRight />
              Compare…
            </Button>
          ) : null}
          <Separator orientation="vertical" className="hidden md:my-1 md:block" />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={toggleTheme}
            title={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
            aria-label={isDarkMode ? 'Switch to light mode' : 'Switch to dark mode'}
          >
            {isDarkMode ? <Sun /> : <Moon />}
          </Button>
        </div>
      </header>

      {hasTabs ? (
        <div className="grid min-h-0 min-w-0 grid-rows-[auto_1fr]">
          <div className="min-w-0">
            <TabStrip
              tabs={openTabs}
              activeTabId={activeTabId}
              onSelectTab={(tabId) => workspace.select(tabId)}
              onCloseTab={(tab) => void workspace.close(tab.id)}
            />
            {openError ? (
              <FieldError className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 font-semibold">
                {openError}
              </FieldError>
            ) : null}
          </div>
          <div className="grid min-h-0 min-w-0">
            {csvTabs.map((tab) => {
              const isActive = tab.id === activeTabId;
              const activeDialectError = isActive ? dialectError : null;
              return (
                <section
                  key={tab.id}
                  className={cn(
                    'col-start-1 row-start-1 grid min-h-0 min-w-0 gap-3 p-3 md:p-4',
                    activeDialectError ? 'grid-rows-[auto_1fr]' : 'grid-rows-[1fr]',
                    !isActive && 'hidden',
                  )}
                  aria-labelledby="metadata-title"
                >
                  {activeDialectError ? (
                    <FieldError className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 font-semibold">
                      {activeDialectError}
                    </FieldError>
                  ) : null}
                  <CsvGrid tab={tab.tab} themeMode={themeMode} />
                </section>
              );
            })}
            {comparisonTabs.map((tab) => (
              <div
                key={tab.id}
                className={cn('col-start-1 row-start-1 grid min-h-0 min-w-0', tab.id !== activeTabId && 'hidden')}
              >
                <ComparisonPanel tab={tab.tab} themeMode={themeMode} />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <EmptyCsvState
          recentSources={workspaceState.recentSources}
          isOpening={isOpening}
          errorMessage={openError}
          dialectError={dialectError}
          onOpenCsv={() => workspace.open()}
          onOpenRecent={(sourceId) => workspace.openRecent(sourceId)}
        />
      )}
      {candidatePicker ? (
        <ComparisonCandidateDialog
          baseline={candidatePicker.baseline}
          candidates={candidatePicker.candidates}
          onChoose={(candidateId) => void chooseCandidate(candidateId)}
          onClose={closeCandidatePicker}
        />
      ) : null}
      <Toaster timeout={3000} />
    </main>
  );
}
