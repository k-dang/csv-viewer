import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { AlertTriangle, ArrowLeftRight, FolderOpen, Loader2, Moon, RefreshCw, Sun, Table2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';
import { cn } from '@/lib/utils';
import { buildDialectOptions, isDialectError, type CsvHeaderMode } from '@/components/csv-dialect';
import { ComparisonCandidateDialog } from '@/components/comparison-candidate-dialog';
import { ComparisonTab } from '@/components/comparison-tab';
import { CsvGrid } from '@/components/csv-grid';
import { DialectControls } from '@/components/dialect-controls';
import { EmptyCsvState } from '@/components/empty-csv-state';
import { TabStrip, type OpenRendererTab } from '@/components/tab-strip';
import type {
  ComparisonCandidate,
  CsvDialectOptions,
  CsvViewerIntent,
  CsvViewerRequest,
  WorkingCsvView,
  OpenCsvResult,
  CsvSourceId,
} from '@csv-viewer/workspace/csv-viewer';
import {
  initialRendererWorkspace,
  projectOpenTabs,
  rendererWorkspaceReducer,
  type ComparisonTabPresentation,
  type RendererTab,
} from './workspace-tabs';
import { CsvTab } from './csv-tab';
import { useCsvViewer } from './csv-viewer';

type ThemeMode = 'light' | 'dark';

const themeStorageKey = 'csv-viewer-theme';

/** Every request that opens a Working CSV, so runOpen covers all three the same way. */
type OpenRequest = Extract<CsvViewerRequest, { operation: 'csv.open' | 'csv.open-recent' | 'csv.reopen' }>;

function getInitialTheme(): ThemeMode {
  const storedTheme = window.localStorage.getItem(themeStorageKey);
  if (storedTheme === 'light' || storedTheme === 'dark') return storedTheme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function App() {
  const viewer = useCsvViewer();
  const [workspaceState, dispatchWorkspace] = useReducer(rendererWorkspaceReducer, initialRendererWorkspace);
  const [candidatePicker, setCandidatePicker] = useState<{
    baseline: WorkingCsvView;
    candidates: ComparisonCandidate[];
  } | null>(null);
  const [isOpening, setIsOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [delimiter, setDelimiter] = useState('');
  const [headerMode, setHeaderMode] = useState<CsvHeaderMode>('auto');
  const [dialectError, setDialectError] = useState<string | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(getInitialTheme);

  const openTabs = useMemo<OpenRendererTab[]>(() => projectOpenTabs(workspaceState), [workspaceState]);
  const csvTabs = openTabs.filter((tab): tab is Extract<OpenRendererTab, { kind: 'csv' }> => tab.kind === 'csv');
  const comparisonTabs = workspaceState.tabs.filter(
    (tab): tab is Extract<RendererTab, { kind: 'comparison' }> => tab.kind === 'comparison',
  );
  const activeTabId = workspaceState.activeTabId;

  const activeTab = openTabs.find((tab) => tab.id === activeTabId) ?? null;
  const activeCsvTab = activeTab?.kind === 'csv' ? activeTab.tab : null;

  // Open results arrive after an await, so they look up CSV Tabs through the latest state.
  const csvTabsRef = useRef(csvTabs);
  useEffect(() => {
    csvTabsRef.current = csvTabs;
  });

  useEffect(() => {
    document.documentElement.classList.toggle('dark', themeMode === 'dark');
    document.documentElement.style.colorScheme = themeMode;
    window.localStorage.setItem(themeStorageKey, themeMode);
  }, [themeMode]);

  // One handler per intent, so a new CsvViewerIntent cannot compile until this dispatch covers it.
  const intentHandlers = {
    'open-csv': () => void openCsv(),
    'reopen-csv': () => void reopenActiveTab(),
    'export-csv': () => void activeCsvTab?.export(),
    'close-tab': () => {
      if (activeTab) void closeTab(activeTab);
    },
  } satisfies Record<CsvViewerIntent, () => void>;

  // Held in a ref so the seam subscription outlives every render instead of churning with it.
  // Written from an effect, not during render, so a discarded render cannot leave its handlers
  // behind for an intent to act on.
  const intentHandlersRef = useRef(intentHandlers);
  useEffect(() => {
    intentHandlersRef.current = intentHandlers;
  });

  useEffect(
    () =>
      viewer.onEvent((event) => {
        if (event.type === 'comparison') {
          dispatchWorkspace({ type: 'comparison-event', event: event.event });
        } else if (event.type === 'intent') {
          intentHandlersRef.current[event.intent]();
        } else {
          setFatalError(event.message);
        }
      }),
    [viewer],
  );

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Tab' && event.ctrlKey) {
        event.preventDefault();
        dispatchWorkspace({ type: 'cycle', direction: event.shiftKey ? -1 : 1 });
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // Registered once; it reads the CSV Tabs when it fires, so no unexported-changes state is mirrored here.
  useEffect(() => {
    if (!viewer.capabilities.warnOnPageUnload) return;

    function warnBeforeUnload(event: BeforeUnloadEvent) {
      if (!csvTabsRef.current.some((tab) => tab.tab.snapshot().editState.hasUnexportedChanges)) return;
      event.preventDefault();
      event.returnValue = '';
    }

    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => window.removeEventListener('beforeunload', warnBeforeUnload);
  }, [viewer.capabilities.warnOnPageUnload]);

  /**
   * A Working CSV that is already open keeps its CSV Tab: a Reopen replaces the Tab's data, and
   * a second open of the same CSV Source only focuses it.
   */
  function applyOpenResult(result: OpenCsvResult) {
    if (result.status === 'cancelled') return;
    if (result.status === 'failed' || result.status === 'capacity-exceeded') {
      setOpenError(result.message);
      return;
    }
    const { workingCsv } = result;
    const existing = csvTabsRef.current.find((tab) => tab.tab.workingCsvId === workingCsv.workingCsvId)?.tab;
    if (!existing) {
      dispatchWorkspace({ type: 'open-csv', tab: new CsvTab(viewer, workingCsv) });
    } else {
      if (result.status === 'opened') existing.replaceWorkingCsv(workingCsv);
      dispatchWorkspace({ type: 'open-csv', tab: existing });
    }
    setOpenError(null);
  }

  async function runOpen(toRequest: (options: CsvDialectOptions) => OpenRequest, failureMessage: string) {
    const options = buildDialectOptions(delimiter, headerMode);
    if (isDialectError(options)) {
      setDialectError(options);
      return;
    }
    setDialectError(null);
    setIsOpening(true);
    try {
      applyOpenResult(await viewer.call(toRequest(options)));
    } catch (error: unknown) {
      setOpenError(error instanceof Error ? error.message : failureMessage);
    } finally {
      setIsOpening(false);
    }
  }

  async function openCsv() {
    await runOpen((options) => ({ operation: 'csv.open', options }), 'Unable to open CSV.');
  }

  async function openRecentCsv(sourceId: CsvSourceId) {
    await runOpen(
      (options) => ({ operation: 'csv.open-recent', sourceId, options }),
      'Unable to open recent CSV.',
    );
  }

  async function reopenActiveTab() {
    if (!activeCsvTab) return;
    await runOpen(
      (options) => ({ operation: 'csv.reopen', workingCsvId: activeCsvTab.workingCsvId, options }),
      'Unable to reopen CSV.',
    );
  }

  async function showCandidatePicker() {
    if (!activeCsvTab) return;
    try {
      setCandidatePicker({
        baseline: activeCsvTab.snapshot().workingCsv,
        candidates: await viewer.call({
          operation: 'comparison.get-candidates',
          baselineId: activeCsvTab.workingCsvId,
        }),
      });
    } catch (error: unknown) {
      setOpenError(error instanceof Error ? error.message : 'Unable to list comparison candidates.');
    }
  }

  async function chooseCandidate(candidateId: string) {
    if (!candidatePicker) return;
    try {
      const result = await viewer.call({
        operation: 'comparison.open',
        baselineId: candidatePicker.baseline.workingCsvId,
        candidateId,
      });
      if (result.status === 'rejected') {
        setOpenError(result.fault.message);
        return;
      }
      const comparison = result.comparison;
      dispatchWorkspace({ type: 'open-comparison', comparison });
      setCandidatePicker(null);
    } catch (error: unknown) {
      setOpenError(error instanceof Error ? error.message : 'Unable to open Comparison.');
    }
  }

  async function closeTab(tab: OpenRendererTab) {
    try {
      if (tab.kind === 'comparison') {
        const result = await viewer.call({
          operation: 'comparison.close',
          comparisonId: tab.comparison.comparisonId,
        });
        if (result.status === 'failed') setOpenError(result.failure.message);
        return;
      }
      const { workingCsvId } = tab.tab;
      let result = await viewer.call({ operation: 'csv.close', workingCsvId });
      while (result.status === 'confirmation-required') {
        const dependentNames = result.impact.dependentComparisons.map(
          (comparison) => `${comparison.baselineName} ⇄ ${comparison.candidateName}`,
        );
        const impact = [
          result.impact.hasUnexportedChanges ? 'Unexported Changes will be lost.' : null,
          dependentNames.length > 0
            ? `These dependent Comparison Tabs will also close:\n${dependentNames.join('\n')}`
            : null,
        ]
          .filter(Boolean)
          .join('\n\n');
        if (!window.confirm(`Close ${tab.tab.snapshot().workingCsv.source.name}?\n\n${impact}`)) return;
        result = await viewer.call({ operation: 'csv.close', workingCsvId, confirmedImpact: result.impact });
      }
      if (result.status === 'failed') {
        setOpenError(result.failure.message);
        return;
      }
      if (result.status !== 'closed') return;
      for (const comparisonId of result.closedComparisonIds) {
        dispatchWorkspace({
          type: 'comparison-event',
          event: { kind: 'closed', comparisonId },
        });
      }
      tab.tab.dispose();
      dispatchWorkspace({ type: 'close-csv', workingCsvId });
    } catch (error: unknown) {
      setOpenError(error instanceof Error ? error.message : 'Unable to close the Tab.');
    }
  }

  function updateComparisonPresentation(comparisonId: string, presentation: ComparisonTabPresentation) {
    dispatchWorkspace({
      type: 'update-comparison-presentation',
      comparisonId,
      presentation,
    });
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
          <Button type="button" onClick={openCsv} disabled={isOpening}>
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
            <Button type="button" variant="outline" onClick={reopenActiveTab} disabled={isOpening}>
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
              onSelectTab={(tabId) => dispatchWorkspace({ type: 'select', tabId })}
              onCloseTab={(tab) => void closeTab(tab)}
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
              const comparison = workspaceState.comparisons.get(tab.comparisonId);
              if (!comparison) return null;
              return (
                <div
                  key={tab.comparisonId}
                  className={cn('col-start-1 row-start-1 grid min-h-0 min-w-0', tab.id !== activeTabId && 'hidden')}
                >
                  <ComparisonTab
                    comparison={comparison}
                    presentation={tab.presentation}
                    themeMode={themeMode}
                    onPresentationChange={(presentation) =>
                      updateComparisonPresentation(tab.comparisonId, presentation)
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
          onOpenCsv={openCsv}
          onOpenRecent={openRecentCsv}
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
