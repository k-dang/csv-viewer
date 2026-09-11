import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { AlertTriangle, ArrowLeftRight, FolderOpen, Loader2, Moon, RefreshCw, Sun, Table2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';
import { cn } from '@/lib/utils';
import { buildDialectOptions, isDialectError, type CsvHeaderMode } from '@/csv/csv-dialect';
import { ComparisonCandidateDialog } from '@/comparison/comparison-candidate-dialog';
import { ComparisonTab } from '@/comparison/comparison-tab';
import { CsvGrid } from '@/csv/csv-grid';
import { DialectControls } from '@/csv/dialect-controls';
import { EmptyCsvState } from '@/csv/empty-csv-state';
import { TabStrip } from '@/app/tab-strip';
import type { CloseImpact, ComparisonCandidate, CsvDialectOptions, WorkingCsvView } from '@csv-viewer/workspace/csv-viewer';
import { RendererWorkspace } from './renderer-workspace';
import { useCsvViewer } from './csv-viewer';

type ThemeMode = 'light' | 'dark';
const themeStorageKey = 'csv-viewer-theme';

function getInitialTheme(): ThemeMode {
  const storedTheme = window.localStorage.getItem(themeStorageKey);
  if (storedTheme === 'light' || storedTheme === 'dark') return storedTheme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function confirmTabClose(sourceName: string, impact: CloseImpact): boolean {
  const dependentNames = impact.dependentComparisons.map(
    (comparison) => `${comparison.baselineName} ⇄ ${comparison.candidateName}`,
  );
  const description = [
    impact.hasUnexportedChanges ? 'Unexported Changes will be lost.' : null,
    dependentNames.length > 0
      ? `These dependent Comparison Tabs will also close:\n${dependentNames.join('\n')}`
      : null,
  ].filter(Boolean).join('\n\n');
  return window.confirm(`Close ${sourceName}?\n\n${description}`);
}

/** Each committed mount owns a fresh workspace, including Strict Mode's effect replay. */
export function App() {
  const viewer = useCsvViewer();
  const openOptions = useRef<() => CsvDialectOptions | null>(() => ({}));
  const [workspace, setWorkspace] = useState<RendererWorkspace | null>(null);
  useEffect(() => {
    const owned = new RendererWorkspace(viewer, {
      openOptions: () => openOptions.current(),
      confirmClose: confirmTabClose,
    });
    setWorkspace(owned);
    return () => owned.dispose();
  }, [viewer]);
  return workspace ? <WorkspaceView workspace={workspace} openOptions={openOptions} /> : null;
}

function WorkspaceView({
  workspace,
  openOptions,
}: {
  workspace: RendererWorkspace;
  openOptions: RefObject<() => CsvDialectOptions | null>;
}) {
  const viewer = useCsvViewer();
  const workspaceState = useSyncExternalStore(workspace.subscribe, workspace.snapshot);
  const [candidatePicker, setCandidatePicker] = useState<{
    baseline: WorkingCsvView;
    candidates: ComparisonCandidate[];
  } | null>(null);
  const [delimiter, setDelimiter] = useState('');
  const [headerMode, setHeaderMode] = useState<CsvHeaderMode>('auto');
  const [dialectError, setDialectError] = useState<string | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(getInitialTheme);

  const { tabs: openTabs, activeTabId, isOpening, error: openError, fatalError } = workspaceState;
  const csvTabs = openTabs.filter((tab) => tab.kind === 'csv');
  const comparisonTabs = openTabs.filter((tab) => tab.kind === 'comparison');
  const activeTab = openTabs.find((tab) => tab.id === activeTabId);
  const activeCsvTab = activeTab?.kind === 'csv' ? activeTab.tab : null;

  // Only form input crosses this ref. Menu and button commands share current workspace state.
  useEffect(() => {
    openOptions.current = () => {
      const options = buildDialectOptions(delimiter, headerMode);
      if (isDialectError(options)) {
        setDialectError(options);
        return null;
      }
      setDialectError(null);
      return options;
    };
  }, [delimiter, headerMode, openOptions]);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', themeMode === 'dark');
    document.documentElement.style.colorScheme = themeMode;
    window.localStorage.setItem(themeStorageKey, themeMode);
  }, [themeMode]);

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
      <header className="flex min-h-[78px] flex-col items-start justify-center gap-4 border-b bg-card/92 px-5 py-4 shadow-[0_1px_0_rgba(15,23,42,0.04)] backdrop-blur md:h-[78px] md:flex-row md:items-center md:justify-between md:gap-6 md:px-7 md:py-0">
        <div className="flex min-w-0 items-center gap-3">
          <div
            className="grid size-10 shrink-0 place-items-center rounded-lg border border-primary/10 bg-primary text-primary-foreground shadow-sm"
            aria-hidden="true"
          >
            <Table2 className="size-5" />
          </div>
          <div className="min-w-0">
            <p className="mb-1 text-xs font-bold uppercase text-muted-foreground">Local CSV workspace</p>
            <h1 className="truncate text-[22px] leading-tight font-semibold text-foreground">CSV Viewer</h1>
          </div>
        </div>
        <div className="flex flex-col items-stretch gap-3 md:flex-row md:items-center">
          <DialectControls
            delimiter={delimiter}
            headerMode={headerMode}
            onDelimiterChange={setDelimiter}
            onHeaderModeChange={setHeaderMode}
          />
          <Button type="button" onClick={() => void workspace.open()} disabled={isOpening}>
            {isOpening ? <Loader2 className="animate-spin" /> : <FolderOpen />}
            {isOpening ? 'Opening...' : 'Open CSV'}
          </Button>
          {activeCsvTab ? (
            <Button
              type="button"
              variant="outline"
              onClick={() => void showCandidatePicker()}
              disabled={csvTabs.length < 2}
            >
              <ArrowLeftRight />
              Compare…
            </Button>
          ) : null}
          {activeCsvTab ? (
            <Button type="button" variant="outline" onClick={() => void workspace.reopen()} disabled={isOpening}>
              <RefreshCw />
              Reopen
            </Button>
          ) : null}
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => setThemeMode(isDarkMode ? 'light' : 'dark')}
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
            {comparisonTabs.map((tab) => {
              const comparison = tab.comparison;
              return (
                <div
                  key={comparison.comparisonId}
                  className={cn('col-start-1 row-start-1 grid min-h-0 min-w-0', tab.id !== activeTabId && 'hidden')}
                >
                  <ComparisonTab
                    comparison={comparison}
                    presentation={tab.presentation}
                    themeMode={themeMode}
                    onPresentationChange={(presentation) =>
                      workspace.updateComparisonPresentation(comparison.comparisonId, presentation)
                    }
                  />
                </div>
              );
            })}
          </div>
        </div>
      ) : (
        <EmptyCsvState
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
    </main>
  );
}
