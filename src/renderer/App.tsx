import { useEffect, useRef, useState } from 'react';
import { FolderOpen, Loader2, RefreshCw, Table2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { buildDialectOptions, type CsvHeaderMode } from '@/components/csv-dialect';
import { CsvMetadataView } from '@/components/csv-metadata-view';
import { DialectControls } from '@/components/dialect-controls';
import { EmptyCsvState } from '@/components/empty-csv-state';
import { HealthBadge, type HealthState } from '@/components/health-badge';
import type { CsvSessionMetadata, RecentCsvFile } from '../shared/ipc';

type OpenState =
  | { status: 'idle' }
  | { status: 'opening' }
  | { status: 'opened'; session: CsvSessionMetadata }
  | { status: 'failed'; message: string };

export function App() {
  const [health, setHealth] = useState<HealthState>({ status: 'checking' });
  const [openState, setOpenState] = useState<OpenState>({ status: 'idle' });
  const [delimiter, setDelimiter] = useState('');
  const [headerMode, setHeaderMode] = useState<CsvHeaderMode>('auto');
  const [dialectError, setDialectError] = useState<string | null>(null);
  const [recentFiles, setRecentFiles] = useState<RecentCsvFile[]>([]);
  const openRequestRef = useRef(0);

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
      void reopenCsv();
    });

    return () => {
      removeOpenListener();
      removeReopenListener();
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

  async function openCsv() {
    const options = buildDialectOptions(delimiter, headerMode);

    if (typeof options === 'string') {
      setDialectError(options);
      return;
    }

    setDialectError(null);
    const requestId = openRequestRef.current + 1;
    openRequestRef.current = requestId;
    setOpenState({ status: 'opening' });

    try {
      const result = await window.csvViewer.openCsv(options);

      if (requestId !== openRequestRef.current) {
        return;
      }

      if (result.status === 'cancelled') {
        setOpenState((current) => (current.status === 'opening' ? { status: 'idle' } : current));
        return;
      }

      setOpenState({ status: 'opened', session: result.session });
      await refreshRecentFiles();
    } catch (error: unknown) {
      if (requestId !== openRequestRef.current) {
        return;
      }

      setOpenState({
        status: 'failed',
        message: error instanceof Error ? error.message : 'Unable to open CSV.',
      });
    }
  }

  async function openRecentCsv(filePath: string) {
    const options = buildDialectOptions(delimiter, headerMode);

    if (typeof options === 'string') {
      setDialectError(options);
      return;
    }

    setDialectError(null);
    const requestId = openRequestRef.current + 1;
    openRequestRef.current = requestId;
    setOpenState({ status: 'opening' });

    try {
      const result = await window.csvViewer.openRecentCsv(filePath, options);

      if (requestId !== openRequestRef.current) {
        return;
      }

      if (result.status === 'opened') {
        setOpenState({ status: 'opened', session: result.session });
        await refreshRecentFiles();
      }
    } catch (error: unknown) {
      if (requestId !== openRequestRef.current) {
        return;
      }

      setOpenState({
        status: 'failed',
        message: error instanceof Error ? error.message : 'Unable to open recent CSV.',
      });
      await refreshRecentFiles();
    }
  }

  async function reopenCsv() {
    const options = buildDialectOptions(delimiter, headerMode);

    if (typeof options === 'string') {
      setDialectError(options);
      return;
    }

    setDialectError(null);
    const requestId = openRequestRef.current + 1;
    openRequestRef.current = requestId;
    setOpenState({ status: 'opening' });

    try {
      const result = await window.csvViewer.reopenCsv(options);

      if (requestId !== openRequestRef.current) {
        return;
      }

      if (result.status === 'opened') {
        setOpenState({ status: 'opened', session: result.session });
        await refreshRecentFiles();
      }
    } catch (error: unknown) {
      if (requestId !== openRequestRef.current) {
        return;
      }

      setOpenState({
        status: 'failed',
        message: error instanceof Error ? error.message : 'Unable to reopen CSV.',
      });
    }
  }

  const isOpening = openState.status === 'opening';

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
          {openState.status === 'opened' ? (
            <Button type="button" variant="outline" onClick={reopenCsv} disabled={isOpening}>
              <RefreshCw />
              Reopen
            </Button>
          ) : null}
          <HealthBadge health={health} />
        </div>
      </header>

      {openState.status === 'opened' ? (
        <CsvMetadataView session={openState.session} dialectError={dialectError} />
      ) : (
        <EmptyCsvState
          isOpening={isOpening}
          errorMessage={openState.status === 'failed' ? openState.message : null}
          dialectError={dialectError}
          recentFiles={recentFiles}
          onOpenCsv={openCsv}
          onOpenRecent={openRecentCsv}
        />
      )}
    </main>
  );
}
