import { useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import {
  AllCommunityModule,
  ModuleRegistry,
  type ColDef,
  type GridApi,
  type GridReadyEvent,
} from 'ag-grid-community';
import { Database, HardDrive, RotateCcw, Search, Table2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { CsvCellValue, CsvRow, CsvSessionMetadata } from '../../shared/ipc';
import { createCsvGridDataSource } from '../ui/csv-grid-data-source';
import { formControlClassName } from './dialect-controls';
import { formatCellValue, formatFileSize, formatNumber } from './csv-format';
import { QueryStatusBadge, type QueryState } from './query-status-badge';

ModuleRegistry.registerModules([AllCommunityModule]);

export function CsvGrid({ session }: { session: CsvSessionMetadata }) {
  const gridApiRef = useRef<GridApi<CsvRow> | null>(null);
  const [filteredRowCount, setFilteredRowCount] = useState(session.rowCount);
  const [hasActiveQuery, setHasActiveQuery] = useState(false);
  const [queryState, setQueryState] = useState<QueryState>('idle');
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
      setQueryState,
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
      setQueryState,
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
      setQueryState,
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
    <div className="grid min-h-0 grid-rows-[auto_1fr] overflow-hidden rounded-lg border bg-card shadow-sm">
      <div className="flex min-h-[64px] flex-col gap-3 border-b bg-card/90 px-[18px] py-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground" aria-hidden="true">
            <Database className="size-4" />
          </span>
          <div className="min-w-0">
            <h2 id="metadata-title" className="truncate text-base font-semibold text-foreground" title={session.file.name}>
              {session.file.name}
            </h2>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
              <span>{formatNumber(filteredRowCount)} visible of {formatNumber(session.rowCount)} rows</span>
              <span className="inline-flex items-center gap-1.5">
                <Table2 className="size-3.5" aria-hidden="true" />
                {formatNumber(session.columns.length)} columns
              </span>
              <span className="inline-flex items-center gap-1.5">
                <HardDrive className="size-3.5" aria-hidden="true" />
                {formatFileSize(session.file.sizeBytes)}
              </span>
            </div>
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <QueryStatusBadge state={queryState} />
          <label className="sr-only" htmlFor="global-search">
            Global search
          </label>
          <div className="relative min-w-0 sm:w-[270px]">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <input
              id="global-search"
              className={cn(formControlClassName, 'w-full min-w-0 pr-3 pl-9')}
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search all columns"
            />
          </div>
          <Button type="button" variant="outline" onClick={clearQuery} disabled={!canClearQuery}>
            <RotateCcw />
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
          overlayNoRowsTemplate="<span class='ag-overlay-loading-center'>No rows match the current query.</span>"
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
  if (/^(DATE|TIMESTAMP|TIMESTAMP_TZ|TIME)/i.test(columnType)) {
    return 180;
  }

  return 140;
}
