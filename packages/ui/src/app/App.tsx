import { useCallback, useRef, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, ArrowLeftRight, FolderOpen, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/toast';
import { FieldError } from '@/components/ui/field';
import { cn } from '@/lib/utils';
import { ComparisonCandidateDialog } from '@/comparison/comparison-candidate-dialog';
import { ComparisonPanel } from '@/comparison/comparison-panel';
import { CsvGrid } from '@/csv/csv-grid';
import { EmptyCsvState } from '@/csv/empty-csv-state';
import { isHelpToggle, ShortcutsHelpDialog } from '@/app/shortcuts-help-dialog';
import { FileDropZone } from './file-drop-zone';
import { WorkbenchLayout } from './workbench-layout';
import type { ComparisonCandidate, WorkingCsvView } from '@csv-viewer/workspace/csv-viewer';
import type { RendererWorkspace } from './renderer-workspace';
import { useCsvViewer } from './csv-viewer';
import {
  applyPalette,
  applyTheme,
  getInitialPalette,
  getInitialTheme,
  type ThemeMode,
  type ThemePalette,
} from './theme';

export function App({ workspace }: { workspace: RendererWorkspace }) {
  const viewer = useCsvViewer();
  const workspaceState = useSyncExternalStore(workspace.subscribe, workspace.snapshot);
  const [candidatePicker, setCandidatePicker] = useState<{
    baseline: WorkingCsvView;
    candidates: ComparisonCandidate[];
  } | null>(null);
  const { delimiter, headerMode, dialectError } = workspaceState;
  const [themeMode, setThemeMode] = useState<ThemeMode>(getInitialTheme);
  const [palette, setPalette] = useState<ThemePalette>(getInitialPalette);
  const [helpOpen, setHelpOpen] = useState(false);
  const closeShortcutsHelp = useCallback(() => setHelpOpen(false), []);

  const { tabs: openTabs, activeTabId, isOpening, error: openError, fatalError } = workspaceState;
  const csvTabs = openTabs.filter((tab) => tab.kind === 'csv');
  const comparisonTabs = openTabs.filter((tab) => tab.kind === 'comparison');

  function toggleTheme() {
    const nextTheme = themeMode === 'dark' ? 'light' : 'dark';
    applyTheme(nextTheme);
    setThemeMode(nextTheme);
  }

  function changePalette(nextPalette: ThemePalette) {
    applyPalette(nextPalette);
    setPalette(nextPalette);
  }

  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;
  const warnOnPageUnloadRef = useRef(viewer.capabilities.warnOnPageUnload);
  warnOnPageUnloadRef.current = viewer.capabilities.warnOnPageUnload;

  const bindShell = useCallback((node: HTMLElement | null) => {
    if (!node) return;
    function handleKeyDown(event: KeyboardEvent) {
      if (isHelpToggle(event)) {
        event.preventDefault();
        setHelpOpen((open) => !open);
        return;
      }
      if (event.key === 'Tab' && event.ctrlKey) {
        event.preventDefault();
        workspaceRef.current.cycle(event.shiftKey ? -1 : 1);
      }
    }
    function warnBeforeUnload(event: BeforeUnloadEvent) {
      if (!warnOnPageUnloadRef.current || !workspaceRef.current.hasUnexportedChanges()) return;
      event.preventDefault();
      event.returnValue = '';
    }
    window.addEventListener('keydown', handleKeyDown);
    window.addEventListener('beforeunload', warnBeforeUnload);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('beforeunload', warnBeforeUnload);
    };
  }, []);

  async function showCandidatePicker() {
    const candidates = await workspace.candidates();
    if (candidates) setCandidatePicker(candidates);
  }

  async function chooseCandidate(candidateId: string) {
    if (!candidatePicker) return;
    if (await workspace.openComparison(candidatePicker.baseline.workingCsvId, candidateId)) setCandidatePicker(null);
  }

  const closeCandidatePicker = useCallback(() => setCandidatePicker(null), []);

  const hasTabs = openTabs.length > 0;

  if (fatalError !== null) {
    return (
      <main ref={bindShell} className="grid min-h-screen place-items-center bg-background p-6 text-foreground">
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

  // Reopen and Compare act on the active CSV Tab, so they sit in its toolbar rather than the app chrome.
  const fileActions = (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => void workspace.reopen()} disabled={isOpening}>
        <RefreshCw />
        Reopen
      </Button>
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
    </>
  );

  return (
    <>
      <WorkbenchLayout
        shellRef={bindShell}
        onToggleShortcuts={() => setHelpOpen((open) => !open)}
        open={{
          label: isOpening ? 'Opening...' : 'Open CSV',
          icon: isOpening ? <Loader2 className="animate-spin" /> : <FolderOpen />,
          onClick: () => void workspace.open(),
          disabled: isOpening,
        }}
        dialect={{
          delimiter,
          headerMode,
          onDelimiterChange: (value) => workspace.updateDialect(value, headerMode),
          onHeaderModeChange: (value) => workspace.updateDialect(delimiter, value),
        }}
        appearance={{
          palette,
          onPaletteChange: changePalette,
          mode: themeMode,
          onToggleMode: toggleTheme,
        }}
        tabs={{
          tabs: openTabs,
          activeTabId,
          onSelectTab: (tabId) => workspace.select(tabId),
          onCloseTab: (tab) => void workspace.close(tab.id),
        }}
        openError={openError}
      >
        {hasTabs ? (
          <div className="grid min-h-0 min-w-0">
            {csvTabs.map((tab) => {
              const isActive = tab.id === activeTabId;
              const activeDialectError = isActive ? dialectError : null;
              return (
                <section
                  key={tab.id}
                  className={cn(
                    'col-start-1 row-start-1 grid min-h-0 min-w-0',
                    activeDialectError ? 'grid-rows-[auto_1fr]' : 'grid-rows-[1fr]',
                    !isActive && 'hidden',
                  )}
                  aria-labelledby="metadata-title"
                >
                  {activeDialectError ? (
                    <FieldError className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 font-semibold">
                      {activeDialectError}
                    </FieldError>
                  ) : null}
                  <CsvGrid tab={tab.tab} active={isActive} fileActions={isActive ? fileActions : null} />
                </section>
              );
            })}
            {comparisonTabs.map((tab) => (
              <div
                key={tab.id}
                className={cn('col-start-1 row-start-1 grid min-h-0 min-w-0', tab.id !== activeTabId && 'hidden')}
              >
                <ComparisonPanel tab={tab.tab} />
              </div>
            ))}
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
      </WorkbenchLayout>
      {candidatePicker ? (
        <ComparisonCandidateDialog
          baseline={candidatePicker.baseline}
          candidates={candidatePicker.candidates}
          onChoose={(candidateId) => void chooseCandidate(candidateId)}
          onClose={closeCandidatePicker}
        />
      ) : null}
      {helpOpen ? <ShortcutsHelpDialog onClose={closeShortcutsHelp} /> : null}
      <Toaster timeout={3000} />
      <FileDropZone workspace={workspace} />
    </>
  );
}
