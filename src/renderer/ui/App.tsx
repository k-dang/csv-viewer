import { useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import {
  AllCommunityModule,
  ModuleRegistry,
  type ColDef,
  type GridApi,
  type GridReadyEvent,
} from 'ag-grid-community';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type {
  CsvCellValue,
  CsvDialectOptions,
  CsvRow,
  CsvSessionMetadata,
  HealthStatus,
} from '../../shared/ipc';
import { createCsvGridDataSource } from './csv-grid-data-source';

ModuleRegistry.registerModules([AllCommunityModule]);

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
  const [delimiter, setDelimiter] = useState('');
  const [headerMode, setHeaderMode] = useState<'auto' | 'yes' | 'no'>('auto');
  const [dialectError, setDialectError] = useState<string | null>(null);
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
    <main className="grid min-h-screen min-w-0 grid-rows-[auto_1fr] md:min-w-[720px]">
      <header className="flex min-h-[76px] flex-col items-start justify-center gap-4 border-b bg-card px-5 py-4 md:h-[76px] md:flex-row md:items-center md:justify-between md:gap-6 md:px-7 md:py-0">
        <div>
          <p className="mb-1 text-xs font-bold uppercase text-muted-foreground">Desktop CSV Viewer</p>
          <h1 className="text-[22px] leading-tight font-semibold text-foreground">CSV Viewer</h1>
        </div>
        <div className="flex flex-col items-stretch gap-3 md:flex-row md:items-center">
          <DialectControls
            delimiter={delimiter}
            headerMode={headerMode}
            onDelimiterChange={setDelimiter}
            onHeaderModeChange={setHeaderMode}
          />
          <Button type="button" onClick={openCsv} disabled={isOpening}>
            {isOpening ? 'Opening...' : 'Open CSV'}
          </Button>
          {openState.status === 'opened' ? (
            <Button type="button" variant="outline" onClick={reopenCsv} disabled={isOpening}>
              Reopen
            </Button>
          ) : null}
          <HealthBadge health={health} />
        </div>
      </header>

      {openState.status === 'opened' ? (
        <CsvMetadataView session={openState.session} dialectError={dialectError} />
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
            {dialectError ? (
              <p className="font-semibold text-destructive" role="alert">
                {dialectError}
              </p>
            ) : null}
          </div>
        </section>
      )}
    </main>
  );
}

function CsvMetadataView({
  session,
  dialectError,
}: {
  session: CsvSessionMetadata;
  dialectError: string | null;
}) {
  return (
    <section className="grid min-h-0 min-w-0 grid-rows-[auto_1fr] gap-[18px] p-[18px] md:p-7" aria-labelledby="metadata-title">
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
      {dialectError ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm font-semibold text-destructive" role="alert">
          {dialectError}
        </p>
      ) : null}

      <CsvGrid session={session} />
    </section>
  );
}

function DialectControls({
  delimiter,
  headerMode,
  onDelimiterChange,
  onHeaderModeChange,
}: {
  delimiter: string;
  headerMode: 'auto' | 'yes' | 'no';
  onDelimiterChange: (value: string) => void;
  onHeaderModeChange: (value: 'auto' | 'yes' | 'no') => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
      <label className="sr-only" htmlFor="csv-delimiter">
        Delimiter
      </label>
      <input
        id="csv-delimiter"
        className="h-9 w-24 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        value={delimiter}
        maxLength={2}
        onChange={(event) => onDelimiterChange(event.target.value)}
        placeholder="Auto"
        title="Delimiter override"
      />
      <label className="sr-only" htmlFor="csv-header-mode">
        Header mode
      </label>
      <select
        id="csv-header-mode"
        className="h-9 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
        value={headerMode}
        onChange={(event) => onHeaderModeChange(event.target.value as 'auto' | 'yes' | 'no')}
        title="Header handling"
      >
        <option value="auto">Auto header</option>
        <option value="yes">First row headers</option>
        <option value="no">No headers</option>
      </select>
    </div>
  );
}

function CsvGrid({ session }: { session: CsvSessionMetadata }) {
  const gridApiRef = useRef<GridApi<CsvRow> | null>(null);
  const [filteredRowCount, setFilteredRowCount] = useState(session.rowCount);
  const [hasActiveQuery, setHasActiveQuery] = useState(false);
  const [search, setSearch] = useState('');
  const searchRef = useRef(search);
  const requestStateRef = useRef({ latestRequestId: 0 });
  const columnDefs = useMemo<ColDef<CsvRow>[]>(
    () =>
      session.columns.map((column) => ({
        field: column.name,
        headerName: column.name,
        minWidth: getColumnMinWidth(column.type),
        resizable: true,
        sortable: true,
        filter: getColumnFilter(column.type),
        floatingFilter: true,
        suppressMovable: false,
        cellClassRules: {
          'csv-cell-empty': (params) => params.value === '',
          'csv-cell-null': (params) => params.value === null || params.value === undefined,
        },
        valueFormatter: ({ value }) => formatCellValue(value as CsvCellValue | undefined),
      })),
    [session.columns],
  );

  useEffect(() => {
    searchRef.current = search;
  }, [search]);

  function onGridReady(event: GridReadyEvent<CsvRow>) {
    gridApiRef.current = event.api;
    const datasource = createCsvGridDataSource(
      session,
      window.csvViewer,
      setFilteredRowCount,
      searchRef.current,
      requestStateRef.current,
    );
    event.api.setGridOption('datasource', datasource);
  }

  useEffect(() => {
    const api = gridApiRef.current;

    if (!api) {
      return;
    }

    setHasActiveQuery(hasGridSortOrFilters(api) || search.trim().length > 0);
    const datasource = createCsvGridDataSource(
      session,
      window.csvViewer,
      setFilteredRowCount,
      search,
      requestStateRef.current,
    );
    api.setGridOption('datasource', datasource);
  }, [search, session]);

  function clearQuery() {
    const api = gridApiRef.current;

    setSearch('');

    if (!api) {
      return;
    }

    api.applyColumnState({
      defaultState: { sort: null },
    });
    api.setFilterModel(null);
    setFilteredRowCount(session.rowCount);
    setHasActiveQuery(false);
    const datasource = createCsvGridDataSource(
      session,
      window.csvViewer,
      setFilteredRowCount,
      '',
      requestStateRef.current,
    );
    api.setGridOption('datasource', datasource);
  }

  function refreshQuery(event: { api: GridApi<CsvRow> }) {
    setHasActiveQuery(hasGridSortOrFilters(event.api) || searchRef.current.trim().length > 0);
    event.api.refreshInfiniteCache();
  }

  const hasSearch = search.trim().length > 0;
  const canClearQuery = hasActiveQuery || hasSearch || filteredRowCount !== session.rowCount;

  return (
    <div className="grid min-h-0 grid-rows-[auto_1fr] overflow-hidden rounded-lg border bg-card">
      <div className="flex min-h-[62px] flex-col gap-3 border-b px-[18px] py-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h3 className="text-base font-semibold text-foreground">Rows</h3>
          <p className="text-sm text-muted-foreground">
            {formatNumber(filteredRowCount)} visible of {formatNumber(session.rowCount)} total rows,
            {' '}
            {formatNumber(session.columns.length)} columns
          </p>
        </div>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <label className="sr-only" htmlFor="global-search">
            Global search
          </label>
          <input
            id="global-search"
            className="h-9 min-w-0 rounded-md border border-input bg-background px-3 text-sm text-foreground shadow-xs outline-none transition-[border-color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 sm:w-[260px]"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search all columns"
          />
          <Button type="button" variant="outline" onClick={clearQuery} disabled={!canClearQuery}>
            Clear query
          </Button>
        </div>
      </div>
      <div className="ag-theme-alpine min-h-0 w-full" aria-label="CSV row grid">
        <AgGridReact<CsvRow>
          key={session.sessionId}
          columnDefs={columnDefs}
          defaultColDef={{
            editable: false,
            minWidth: 120,
          }}
          rowModelType="infinite"
          cacheBlockSize={100}
          maxBlocksInCache={6}
          rowBuffer={8}
          rowSelection={{ mode: 'multiRow', enableClickSelection: true, checkboxes: false, headerCheckbox: false }}
          enableCellTextSelection
          ensureDomOrder
          suppressDragLeaveHidesColumns
          maintainColumnOrder
          onGridReady={onGridReady}
          onSortChanged={refreshQuery}
          onFilterChanged={refreshQuery}
        />
      </div>
    </div>
  );
}

function hasGridSortOrFilters(api: GridApi<CsvRow>): boolean {
  const hasSort = api.getColumnState().some((column) => Boolean(column.sort));
  const hasFilter = Object.keys(api.getFilterModel()).length > 0;
  return hasSort || hasFilter;
}

function buildDialectOptions(
  delimiter: string,
  headerMode: 'auto' | 'yes' | 'no',
): CsvDialectOptions | string {
  const normalizedDelimiter = delimiter.trim();

  if (normalizedDelimiter.length > 1) {
    return 'Delimiter must be one character, or blank for automatic detection.';
  }

  return {
    ...(normalizedDelimiter ? { delimiter: normalizedDelimiter } : {}),
    ...(headerMode === 'auto' ? {} : { header: headerMode === 'yes' }),
  };
}

function getColumnFilter(columnType: string): string {
  if (/^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|DOUBLE|DECIMAL)/i.test(columnType)) {
    return 'agNumberColumnFilter';
  }

  if (/^(DATE|TIMESTAMP|TIMESTAMP_TZ|TIME)/i.test(columnType)) {
    return 'agDateColumnFilter';
  }

  return 'agTextColumnFilter';
}

function getColumnMinWidth(columnType: string): number {
  if (isDateLikeColumn(columnType)) {
    return 180;
  }

  return 140;
}

function isDateLikeColumn(columnType: string): boolean {
  return /^(DATE|TIMESTAMP|TIMESTAMP_TZ|TIME)/i.test(columnType);
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

function formatCellValue(value: CsvCellValue | undefined): string {
  if (value === undefined) {
    return '';
  }

  if (value === null) {
    return '[null]';
  }

  if (value === '') {
    return '[empty]';
  }

  return String(value);
}
