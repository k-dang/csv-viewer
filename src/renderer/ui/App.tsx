import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { CsvSessionMetadata, HealthStatus } from '../../shared/ipc';

type HealthState =
  | { status: 'checking' }
  | { status: 'healthy'; value: HealthStatus }
  | { status: 'failed'; message: string };

type OpenState =
  | { status: 'idle' }
  | { status: 'opening' }
  | { status: 'opened'; session: CsvSessionMetadata }
  | { status: 'failed'; message: string };

export function App() {
  const [health, setHealth] = useState<HealthState>({ status: 'checking' });
  const [openState, setOpenState] = useState<OpenState>({ status: 'idle' });

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

  async function openCsv() {
    setOpenState({ status: 'opening' });

    try {
      const result = await window.csvViewer.openCsv();

      if (result.status === 'cancelled') {
        setOpenState((current) => (current.status === 'opening' ? { status: 'idle' } : current));
        return;
      }

      setOpenState({ status: 'opened', session: result.session });
    } catch (error: unknown) {
      setOpenState({
        status: 'failed',
        message: error instanceof Error ? error.message : 'Unable to open CSV.',
      });
    }
  }

  const isOpening = openState.status === 'opening';

  return (
    <main className="grid min-h-screen min-w-0 grid-rows-[auto_1fr] md:min-w-[720px]">
      <header className="flex min-h-[76px] flex-col items-start justify-center gap-4 border-b bg-card px-5 py-4 md:h-[76px] md:flex-row md:items-center md:justify-between md:gap-6 md:px-7 md:py-0">
        <div>
          <p className="mb-1 text-xs font-bold uppercase text-muted-foreground">Desktop CSV Viewer</p>
          <h1 className="text-[22px] leading-tight font-semibold text-foreground">CSV Viewer</h1>
        </div>
        <div className="flex flex-col items-stretch gap-3 md:flex-row md:items-center">
          <Button type="button" onClick={openCsv} disabled={isOpening}>
            {isOpening ? 'Opening...' : 'Open CSV'}
          </Button>
          <HealthBadge health={health} />
        </div>
      </header>

      {openState.status === 'opened' ? (
        <CsvMetadataView session={openState.session} />
      ) : (
        <section
          className="grid w-[min(440px,calc(100vw_-_32px))] grid-cols-1 items-center gap-6 self-center justify-self-center rounded-lg border bg-card p-6 shadow-[0_18px_50px_rgba(23,32,42,0.08)] md:w-[min(640px,calc(100vw_-_48px))] md:grid-cols-[96px_minmax(0,1fr)] md:p-8"
          aria-labelledby="empty-state-title"
        >
          <div
            className="grid size-24 place-items-center rounded-lg bg-emerald-100 text-xl font-extrabold text-emerald-900"
            aria-hidden="true"
          >
            CSV
          </div>
          <div className="grid min-w-0 gap-3.5">
            <h2 id="empty-state-title" className="text-[28px] leading-none font-semibold text-foreground">
              No CSV open
            </h2>
            <p className="max-w-[46ch] text-[15px] leading-relaxed text-muted-foreground">
              Open a local CSV file to inspect its columns, row count, and data without loading the
              full file into the renderer.
            </p>
            <Button type="button" onClick={openCsv} disabled={isOpening}>
              {isOpening ? 'Opening...' : 'Open CSV'}
            </Button>
            {openState.status === 'failed' ? (
              <p className="font-semibold text-destructive" role="alert">
                {openState.message}
              </p>
            ) : null}
          </div>
        </section>
      )}
    </main>
  );
}

function CsvMetadataView({ session }: { session: CsvSessionMetadata }) {
  return (
    <section className="grid min-w-0 gap-[18px] p-[18px] md:p-7" aria-labelledby="metadata-title">
      <div className="flex flex-col items-stretch gap-6 rounded-lg border bg-card p-[22px] md:flex-row md:items-start md:justify-between">
        <div>
          <p className="mb-1 text-xs font-bold uppercase text-muted-foreground">Current file</p>
          <h2 id="metadata-title" className="[overflow-wrap:anywhere] text-[26px] leading-tight font-semibold text-foreground">
            {session.file.name}
          </h2>
        </div>
        <dl className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <MetadataStat label="Rows" value={formatNumber(session.rowCount)} />
          <MetadataStat label="Columns" value={formatNumber(session.columns.length)} />
          <MetadataStat label="Size" value={formatFileSize(session.file.sizeBytes)} />
        </dl>
      </div>

      <div className="min-h-0 overflow-hidden rounded-lg border bg-card">
        <h3 className="border-b px-[18px] py-4 text-base font-semibold text-foreground">Inferred columns</h3>
        <div className="max-h-[calc(100vh-238px)] overflow-auto" role="table" aria-label="Inferred CSV columns">
          {session.columns.map((column) => (
            <div
              className="grid grid-cols-1 gap-4 border-b border-border/70 px-[18px] py-[11px] md:grid-cols-[minmax(0,1fr)_180px]"
              role="row"
              key={column.name}
            >
              <span className="min-w-0 break-words text-sm text-foreground/85" role="cell">
                {column.name}
              </span>
              <span className="min-w-0 break-words font-mono text-sm text-muted-foreground" role="cell">
                {column.type}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function MetadataStat({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-md border bg-muted/60 px-3 py-2.5 md:min-w-24">
      <dt className="text-xs font-bold uppercase text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-xl font-bold text-foreground">{value}</dd>
    </div>
  );
}

function HealthBadge({ health }: { health: HealthState }) {
  const baseClassName =
    'shrink-0 rounded-full border px-3 py-[7px] text-[13px] font-semibold';

  if (health.status === 'checking') {
    return (
      <span className={cn(baseClassName, 'border-amber-200 bg-amber-50 text-amber-900')}>
        Checking IPC
      </span>
    );
  }

  if (health.status === 'failed') {
    return (
      <span className={cn(baseClassName, 'border-rose-200 bg-rose-50 text-rose-800')}>
        IPC unavailable
      </span>
    );
  }

  return (
    <span
      className={cn(baseClassName, 'border-emerald-200 bg-emerald-50 text-emerald-800')}
      title={health.value.timestamp}
    >
      Main process connected
    </span>
  );
}

function formatNumber(value: number): string {
  return new Intl.NumberFormat().format(value);
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }

  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unitIndex = 0;

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }

  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[unitIndex]}`;
}
