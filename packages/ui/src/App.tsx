import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { ArrowLeftRight, FolderOpen, Loader2, Moon, RefreshCw, Sun, Table2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';
import { cn } from '@/lib/utils';
import { buildDialectOptions, isDialectError, type CsvHeaderMode } from '@/components/csv-dialect';
import { ComparisonCandidateDialog } from '@/components/comparison-candidate-dialog';
import { ComparisonTab } from '@/components/comparison-tab';
import { CsvMetadataView } from '@/components/csv-metadata-view';
import { DialectControls } from '@/components/dialect-controls';
import { EmptyCsvState } from '@/components/empty-csv-state';
import { TabStrip, type OpenRendererTab } from '@/components/tab-strip';
import type {
  ComparisonCandidate,
  CsvViewerIntent,
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
import { useCsvViewer } from './csv-viewer';

type ThemeMode = 'light' | 'dark';

const themeStorageKey = 'csv-viewer-theme';

export type AppComponents = {
  ComparisonCandidateDialog: typeof ComparisonCandidateDialog;
  ComparisonTab: typeof ComparisonTab;
  CsvMetadataView: typeof CsvMetadataView;
  DialectControls: typeof DialectControls;
  EmptyCsvState: typeof EmptyCsvState;
  TabStrip: typeof TabStrip;
};

const defaultAppComponents: AppComponents = {
  ComparisonCandidateDialog,
  ComparisonTab,
  CsvMetadataView,
  DialectControls,
  EmptyCsvState,
  TabStrip,
};

type AppProps = { components?: AppComponents };

function getInitialTheme(): ThemeMode {
  const storedTheme = window.localStorage.getItem(themeStorageKey);
  if (storedTheme === 'light' || storedTheme === 'dark') return storedTheme;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function App({ components = defaultAppComponents }: AppProps = {}) {
  const {
    ComparisonCandidateDialog: ComparisonCandidateDialogComponent,
    ComparisonTab: ComparisonTabComponent,
    CsvMetadataView: CsvMetadataViewComponent,
    DialectControls: DialectControlsComponent,
    EmptyCsvState: EmptyCsvStateComponent,
    TabStrip: TabStripComponent,
  } = components;
  const viewer = useCsvViewer();
  const [workspaceState, dispatchWorkspace] = useReducer(rendererWorkspaceReducer, initialRendererWorkspace);
  const [workingCsvIdsWithUnexportedChanges, setWorkingCsvIdsWithUnexportedChanges] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const [candidatePicker, setCandidatePicker] = useState<{
    baseline: WorkingCsvView;
    candidates: ComparisonCandidate[];
  } | null>(null);
  const [isOpening, setIsOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [delimiter, setDelimiter] = useState('');
  const [headerMode, setHeaderMode] = useState<CsvHeaderMode>('auto');
  const [dialectError, setDialectError] = useState<string | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>(getInitialTheme);
  const [exportRequest, setExportRequest] = useState<{
    workingCsvId: string;
    sequence: number;
  } | null>(null);

  const openTabs = useMemo<OpenRendererTab[]>(() => projectOpenTabs(workspaceState), [workspaceState]);
  const csvTabs = workspaceState.tabs.filter((tab): tab is Extract<RendererTab, { kind: 'csv' }> => tab.kind === 'csv');
  const comparisonTabs = workspaceState.tabs.filter(
    (tab): tab is Extract<RendererTab, { kind: 'comparison' }> => tab.kind === 'comparison',
  );
  const activeTabId = workspaceState.activeTabId;

  const activeTab = openTabs.find((tab) => tab.id === activeTabId) ?? null;
  const activeCsv = activeTab?.kind === 'csv' ? activeTab.csv : null;

  useEffect(() => {
    document.documentElement.classList.toggle('dark', themeMode === 'dark');
    document.documentElement.style.colorScheme = themeMode;
    window.localStorage.setItem(themeStorageKey, themeMode);
  }, [themeMode]);

  // One handler per intent, so a new CsvViewerIntent cannot compile until this dispatch covers it.
  const intentHandlers = {
    'open-csv': () => void openCsv(),
    'reopen-csv': () => void reopenActiveTab(),
    'export-csv': () => {
      if (!activeCsv) return;
      setExportRequest((current) => ({
        workingCsvId: activeCsv.workingCsvId,
        sequence: (current?.sequence ?? 0) + 1,
      }));
    },
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
        } else {
          intentHandlersRef.current[event.intent]();
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

  function applyOpenResult(result: OpenCsvResult) {
    if (result.status === 'cancelled') return;
    if (result.status === 'failed') {
      setOpenError(result.message);
      return;
    }
    const workingCsv = result.workingCsv;
    dispatchWorkspace({ type: 'open-csv', workingCsv });
    setWorkingCsvIdsWithUnexportedChanges((current) => {
      if (!current.has(workingCsv.workingCsvId) || result.status === 'already-open') return current;
      const next = new Set(current);
      next.delete(workingCsv.workingCsvId);
      return next;
    });
    setOpenError(null);
  }

  async function openCsv() {
    const options = buildDialectOptions(delimiter, headerMode);
    if (isDialectError(options)) {
      setDialectError(options);
      return;
    }
    setDialectError(null);
    setIsOpening(true);
    try {
      const result = await viewer.call({ operation: 'csv.open', options });
      applyOpenResult(result);
    } catch (error: unknown) {
      setOpenError(error instanceof Error ? error.message : 'Unable to open CSV.');
    } finally {
      setIsOpening(false);
    }
  }

  async function openRecentCsv(sourceId: CsvSourceId) {
    const options = buildDialectOptions(delimiter, headerMode);
    if (isDialectError(options)) {
      setDialectError(options);
      return;
    }
    setDialectError(null);
    setIsOpening(true);
    try {
      const result = await viewer.call({
        operation: 'csv.open-recent',
        sourceId,
        options,
      });
      applyOpenResult(result);
    } catch (error: unknown) {
      setOpenError(error instanceof Error ? error.message : 'Unable to open recent CSV.');
    } finally {
      setIsOpening(false);
    }
  }

  async function reopenActiveTab() {
    if (!activeCsv) return;
    const options = buildDialectOptions(delimiter, headerMode);
    if (isDialectError(options)) {
      setDialectError(options);
      return;
    }
    setDialectError(null);
    setIsOpening(true);
    try {
      const result = await viewer.call({
        operation: 'csv.reopen',
        workingCsvId: activeCsv.workingCsvId,
        options,
      });
      applyOpenResult(result);
    } catch (error: unknown) {
      setOpenError(error instanceof Error ? error.message : 'Unable to reopen CSV.');
    } finally {
      setIsOpening(false);
    }
  }

  async function showCandidatePicker() {
    if (!activeCsv) return;
    try {
      setCandidatePicker({
        baseline: activeCsv,
        candidates: await viewer.call({
          operation: 'comparison.get-candidates',
          baselineId: activeCsv.workingCsvId,
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
      let result = await viewer.call({
        operation: 'csv.close',
        workingCsvId: tab.csv.workingCsvId,
      });
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
        if (!window.confirm(`Close ${tab.csv.source.name}?\n\n${impact}`)) return;
        result = await viewer.call({
          operation: 'csv.close',
          workingCsvId: tab.csv.workingCsvId,
          confirmedImpact: result.impact,
        });
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
      forgetWorkingCsv(tab.csv.workingCsvId);
    } catch (error: unknown) {
      setOpenError(error instanceof Error ? error.message : 'Unable to close the Tab.');
    }
  }

  /** Drops the Tab and its export bookkeeping once the workspace no longer holds the Working CSV. */
  function forgetWorkingCsv(workingCsvId: string) {
    dispatchWorkspace({ type: 'close-csv', workingCsvId });
    setWorkingCsvIdsWithUnexportedChanges((current) => {
      if (!current.has(workingCsvId)) return current;
      const next = new Set(current);
      next.delete(workingCsvId);
      return next;
    });
  }

  function handleUnexportedChangesChange(workingCsvId: string, hasUnexportedChanges: boolean) {
    setWorkingCsvIdsWithUnexportedChanges((current) => {
      if (current.has(workingCsvId) === hasUnexportedChanges) return current;
      const next = new Set(current);
      if (hasUnexportedChanges) next.add(workingCsvId);
      else next.delete(workingCsvId);
      return next;
    });
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
          <DialectControlsComponent
            delimiter={delimiter}
            headerMode={headerMode}
            onDelimiterChange={setDelimiter}
            onHeaderModeChange={setHeaderMode}
          />
          <Button type="button" onClick={openCsv} disabled={isOpening}>
            {isOpening ? <Loader2 className="animate-spin" /> : <FolderOpen />}
            {isOpening ? 'Opening...' : 'Open CSV'}
          </Button>
          {activeCsv ? (
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
          {activeCsv ? (
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
            <TabStripComponent
              tabs={openTabs}
              activeTabId={activeTabId}
              workingCsvIdsWithUnexportedChanges={workingCsvIdsWithUnexportedChanges}
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
              const workingCsv = tab.csv;
              return (
                <div
                  key={workingCsv.workingCsvId}
                  className={cn('col-start-1 row-start-1 grid min-h-0 min-w-0', tab.id !== activeTabId && 'hidden')}
                >
                  <CsvMetadataViewComponent
                    workingCsv={workingCsv}
                    dialectError={tab.id === activeTabId ? dialectError : null}
                    themeMode={themeMode}
                    exportRequestSequence={
                      exportRequest?.workingCsvId === workingCsv.workingCsvId ? exportRequest.sequence : 0
                    }
                    onUnexportedChangesChange={(hasUnexportedChanges) =>
                      handleUnexportedChangesChange(workingCsv.workingCsvId, hasUnexportedChanges)
                    }
                  />
                </div>
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
                  <ComparisonTabComponent
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
        <EmptyCsvStateComponent
          isOpening={isOpening}
          errorMessage={openError}
          dialectError={dialectError}
          onOpenCsv={openCsv}
          onOpenRecent={openRecentCsv}
        />
      )}
      {candidatePicker ? (
        <ComparisonCandidateDialogComponent
          baseline={candidatePicker.baseline}
          candidates={candidatePicker.candidates}
          onChoose={(candidateId) => void chooseCandidate(candidateId)}
          onClose={closeCandidatePicker}
        />
      ) : null}
    </main>
  );
}
