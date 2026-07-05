import { useEffect, useState } from 'react';
import { FolderOpen, Loader2, Moon, RefreshCw, Sun, Table2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';
import { cn } from '@/lib/utils';
import { buildDialectOptions, type CsvHeaderMode } from '@/components/csv-dialect';
import { CsvMetadataView } from '@/components/csv-metadata-view';
import { DialectControls } from '@/components/dialect-controls';
import { EmptyCsvState } from '@/components/empty-csv-state';
import { HealthBadge, type HealthState } from '@/components/health-badge';
import { TabStrip } from '@/components/tab-strip';
import type { CsvSessionMetadata, OpenCsvResult, RecentCsvFile } from '../shared/ipc';

type ThemeMode = 'light' | 'dark';

const themeStorageKey = 'csv-viewer-theme';

function getInitialTheme(): ThemeMode {
  const storedTheme = window.localStorage.getItem(themeStorageKey);

  if (storedTheme === 'light' || storedTheme === 'dark') {
    return storedTheme;
  }

  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function App() {
  const [health, setHealth] = useState<HealthState>({ status: 'checking' });
  const [tabs, setTabs] = useState<CsvSessionMetadata[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [dirtySessionIds, setDirtySessionIds] = useState<ReadonlySet<string>>(new Set());
  const [isOpening, setIsOpening] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const [delimiter, setDelimiter] = useState('');
  const [headerMode, setHeaderMode] = useState<CsvHeaderMode>('auto');
  const [dialectError, setDialectError] = useState<string | null>(null);
  const [recentFiles, setRecentFiles] = useState<RecentCsvFile[]>([]);
  const [themeMode, setThemeMode] = useState<ThemeMode>(getInitialTheme);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', themeMode === 'dark');
    document.documentElement.style.colorScheme = themeMode;
    window.localStorage.setItem(themeStorageKey, themeMode);
  }, [themeMode]);

  useEffect(() => {
    let cancelled = false;

    window.csvViewer
      .healthCheck()
      .then((value) => {
        if (!cancelled) {
          setHealth({ status: 'healthy', value });
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setHealth({
            status: 'failed',
            message: error instanceof Error ? error.message : 'Health check failed',
          });
        }
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void refreshRecentFiles();
  }, []);

  useEffect(() => {
    if (!window.csvViewer.onOpenCsvRequest || !window.csvViewer.onReopenCsvRequest) {
      return;
    }

    const removeOpenListener = window.csvViewer.onOpenCsvRequest(() => {
      void openCsv();
    });
    const removeReopenListener = window.csvViewer.onReopenCsvRequest(() => {
      void reopenActiveTab();
    });
    const removeCloseListener = window.csvViewer.onCloseTabRequest?.(() => {
      if (activeSessionId) {
        void closeTab(activeSessionId);
      }
    });

    return () => {
      removeOpenListener();
      removeReopenListener();
      removeCloseListener?.();
    };
  });

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Tab' && event.ctrlKey) {
        event.preventDefault();
        cycleActiveTab(event.shiftKey ? -1 : 1);
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  });

  async function refreshRecentFiles() {
    try {
      const files = await window.csvViewer.getRecentFiles();
      setRecentFiles(files);
    } catch {
      setRecentFiles([]);
    }
  }

  function applyOpenResult(result: OpenCsvResult) {
    if (result.status === 'cancelled') {
      return;
    }

    if (result.status === 'already-open') {
      setActiveSessionId(result.session.sessionId);
      return;
    }

    const session = result.session;
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.file.path === session.file.path);

      if (index === -1) {
        return [...current, session];
      }

      const next = [...current];
      next[index] = session;
      return next;
    });
    setDirtySessionIds((current) => {
      const replaced = tabs.find((tab) => tab.file.path === session.file.path);

      if (!replaced || !current.has(replaced.sessionId)) {
        return current;
      }

      const next = new Set(current);
      next.delete(replaced.sessionId);
      return next;
    });
    setActiveSessionId(session.sessionId);
    setOpenError(null);
  }

  async function openCsv() {
    const options = buildDialectOptions(delimiter, headerMode);

    if (typeof options === 'string') {
      setDialectError(options);
      return;
    }

    setDialectError(null);
    setIsOpening(true);

    try {
      const result = await window.csvViewer.openCsv(options);
      applyOpenResult(result);

      if (result.status === 'opened') {
        await refreshRecentFiles();
      }
    } catch (error: unknown) {
      setOpenError(error instanceof Error ? error.message : 'Unable to open CSV.');
    } finally {
      setIsOpening(false);
    }
  }

  async function openRecentCsv(filePath: string) {
    const options = buildDialectOptions(delimiter, headerMode);

    if (typeof options === 'string') {
      setDialectError(options);
      return;
    }

    setDialectError(null);
    setIsOpening(true);

    try {
      const result = await window.csvViewer.openRecentCsv(filePath, options);
      applyOpenResult(result);

      if (result.status === 'opened') {
        await refreshRecentFiles();
      }
    } catch (error: unknown) {
      setOpenError(error instanceof Error ? error.message : 'Unable to open recent CSV.');
      await refreshRecentFiles();
    } finally {
      setIsOpening(false);
    }
  }

  async function reopenActiveTab() {
    if (!activeSessionId) {
      return;
    }

    const options = buildDialectOptions(delimiter, headerMode);

    if (typeof options === 'string') {
      setDialectError(options);
      return;
    }

    setDialectError(null);
    setIsOpening(true);

    try {
      const result = await window.csvViewer.reopenCsv(activeSessionId, options);
      applyOpenResult(result);

      if (result.status === 'opened') {
        await refreshRecentFiles();
      }
    } catch (error: unknown) {
      setOpenError(error instanceof Error ? error.message : 'Unable to reopen CSV.');
    } finally {
      setIsOpening(false);
    }
  }

  async function closeTab(sessionId: string) {
    try {
      const result = await window.csvViewer.closeCsv(sessionId);

      if (result.status !== 'closed') {
        return;
      }
    } catch (error: unknown) {
      setOpenError(error instanceof Error ? error.message : 'Unable to close the tab.');
      return;
    }

    const index = tabs.findIndex((tab) => tab.sessionId === sessionId);
    const remaining = tabs.filter((tab) => tab.sessionId !== sessionId);

    setTabs(remaining);
    setDirtySessionIds((current) => {
      if (!current.has(sessionId)) {
        return current;
      }

      const next = new Set(current);
      next.delete(sessionId);
      return next;
    });

    if (activeSessionId === sessionId) {
      setActiveSessionId((remaining[index] ?? remaining[index - 1])?.sessionId ?? null);
    }
  }

  function cycleActiveTab(direction: 1 | -1) {
    if (tabs.length < 2 || !activeSessionId) {
      return;
    }

    const index = tabs.findIndex((tab) => tab.sessionId === activeSessionId);

    if (index === -1) {
      return;
    }

    const nextIndex = (index + direction + tabs.length) % tabs.length;
    setActiveSessionId(tabs[nextIndex].sessionId);
  }

  function handleDirtyChange(sessionId: string, dirty: boolean) {
    setDirtySessionIds((current) => {
      if (current.has(sessionId) === dirty) {
        return current;
      }

      const next = new Set(current);

      if (dirty) {
        next.add(sessionId);
      } else {
        next.delete(sessionId);
      }

      return next;
    });
  }

  const isDarkMode = themeMode === 'dark';
  const hasTabs = tabs.length > 0;

  return (
    <main className="app-shell grid min-h-screen min-w-0 grid-rows-[auto_1fr] md:min-w-[720px]">
      <header className="flex min-h-[78px] flex-col items-start justify-center gap-4 border-b bg-card/92 px-5 py-4 shadow-[0_1px_0_rgba(15,23,42,0.04)] backdrop-blur md:h-[78px] md:flex-row md:items-center md:justify-between md:gap-6 md:px-7 md:py-0">
        <div className="flex min-w-0 items-center gap-3">
          <div className="grid size-10 shrink-0 place-items-center rounded-lg border border-primary/10 bg-primary text-primary-foreground shadow-sm" aria-hidden="true">
            <Table2 className="size-5" />
          </div>
          <div className="min-w-0">
            <p className="mb-1 text-xs font-bold uppercase text-muted-foreground">Desktop CSV Viewer</p>
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
          {activeSessionId ? (
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
          <HealthBadge health={health} />
        </div>
      </header>

      {hasTabs ? (
        <div className="grid min-h-0 min-w-0 grid-rows-[auto_1fr]">
          <div className="min-w-0">
            <TabStrip
              tabs={tabs}
              activeSessionId={activeSessionId}
              dirtySessionIds={dirtySessionIds}
              onSelectTab={setActiveSessionId}
              onCloseTab={(sessionId) => void closeTab(sessionId)}
            />
            {openError ? (
              <FieldError className="border-b border-destructive/30 bg-destructive/10 px-4 py-2 font-semibold">
                {openError}
              </FieldError>
            ) : null}
          </div>
          <div className="grid min-h-0 min-w-0">
            {tabs.map((session) => (
              <div
                key={session.sessionId}
                className={cn(
                  'col-start-1 row-start-1 grid min-h-0 min-w-0',
                  session.sessionId !== activeSessionId && 'hidden',
                )}
              >
                <CsvMetadataView
                  session={session}
                  dialectError={session.sessionId === activeSessionId ? dialectError : null}
                  themeMode={themeMode}
                  onDirtyChange={(dirty) => handleDirtyChange(session.sessionId, dirty)}
                />
              </div>
            ))}
          </div>
        </div>
      ) : (
        <EmptyCsvState
          isOpening={isOpening}
          errorMessage={openError}
          dialectError={dialectError}
          recentFiles={recentFiles}
          onOpenCsv={openCsv}
          onOpenRecent={openRecentCsv}
        />
      )}
    </main>
  );
}
