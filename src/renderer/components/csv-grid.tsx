import { useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import {
  CellApiModule,
  CellStyleModule,
  ColumnApiModule,
  DateFilterModule,
  InfiniteRowModelModule,
  ModuleRegistry,
  NumberFilterModule,
  RenderApiModule,
  RowSelectionModule,
  TextEditorModule,
  TextFilterModule,
  themeQuartz,
  type CellValueChangedEvent,
  type ColDef,
  type GridApi,
  type GridReadyEvent,
  type SelectionChangedEvent,
} from 'ag-grid-community';
import { Database, HardDrive, Redo2, RotateCcw, Search, Table2, Trash2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CsvCellValue, CsvEditState, CsvRow, CsvSessionMetadata } from '../../shared/ipc';
import { csvInternalRowIdField } from '../../shared/ipc';
import { createCsvGridDataSource } from './csv-grid-data-source';
import { formatCellValue, formatFileSize, formatNumber } from './csv-format';
import { QueryStatusBadge, type QueryState } from './query-status-badge';

ModuleRegistry.registerModules([
  CellApiModule,
  CellStyleModule,
  ColumnApiModule,
  DateFilterModule,
  InfiniteRowModelModule,
  NumberFilterModule,
  RenderApiModule,
  RowSelectionModule,
  TextEditorModule,
  TextFilterModule,
]);

const csvGridTheme = themeQuartz.withParams({
  accentColor: '#0f766e',
  backgroundColor: '#ffffff',
  borderColor: '#d7dee8',
  browserColorScheme: 'light',
  cellFontSize: 13,
  chromeBackgroundColor: '#f8fafc',
  fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontSize: 13,
  foregroundColor: '#0f172a',
  headerBackgroundColor: '#f1f5f9',
  headerFontSize: 13,
  headerFontWeight: 700,
  headerTextColor: '#111827',
  iconSize: 15,
  oddRowBackgroundColor: '#f8fafc',
  rowHeight: 38,
  selectedRowBackgroundColor: 'rgba(15, 118, 110, 0.12)',
  spacing: 7,
  wrapperBorder: false,
  wrapperBorderRadius: 8,
});

const filterDebounceMs = 1500;

export function CsvGrid({ session }: { session: CsvSessionMetadata }) {
  const gridApiRef = useRef<GridApi<CsvRow> | null>(null);
  const [filteredRowCount, setFilteredRowCount] = useState(session.rowCount);
  const [hasActiveQuery, setHasActiveQuery] = useState(false);
  const [queryState, setQueryState] = useState<QueryState>('idle');
  const [editState, setEditState] = useState<CsvEditState>({
    sessionId: session.sessionId,
    dirty: false,
    canUndo: false,
    canRedo: false,
  });
  const [editError, setEditError] = useState<string | null>(null);
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const searchRef = useRef(search);
  const requestStateRef = useRef({ latestRequestId: 0 });
  const revertingCellRef = useRef(false);
  const columnDefs = useMemo<ColDef<CsvRow>[]>(
    () =>
      session.columns.map((column) => ({
        field: column.name,
        headerName: column.name,
        minWidth: getColumnMinWidth(column.type),
        resizable: true,
        sortable: true,
        filter: getColumnFilter(column.type),
        filterParams: {
          debounceMs: filterDebounceMs,
        },
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

  useEffect(() => {
    setEditState({
      sessionId: session.sessionId,
      dirty: false,
      canUndo: false,
      canRedo: false,
    });
    setEditError(null);
    setSelectedRowIds([]);
    void refreshEditState();
  }, [session.sessionId]);

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

  async function onCellValueChanged(event: CellValueChangedEvent<CsvRow>) {
    if (revertingCellRef.current) {
      return;
    }

    const rowId = event.data?.[csvInternalRowIdField];
    const column = event.colDef.field;

    if (!rowId || !column) {
      return;
    }

    try {
      setEditError(null);
      const result = await window.csvViewer.editCsvCell({
        sessionId: session.sessionId,
        rowId,
        column,
        value: String(event.newValue ?? ''),
      });
      setEditState(result);
      event.api.refreshInfiniteCache();
      setSelectedRowIds([]);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to edit cell.';
      setEditError(message);
      revertingCellRef.current = true;
      event.node.setDataValue(column, event.oldValue as CsvCellValue);
      revertingCellRef.current = false;
    }
  }

  async function refreshEditState() {
    try {
      setEditState(await window.csvViewer.getCsvEditState({ sessionId: session.sessionId }));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to read edit state.';
      setEditError(message);
    }
  }

  async function runHistoryAction(action: 'undo' | 'redo') {
    const api = gridApiRef.current;

    try {
      setEditError(null);
      const nextEditState =
        action === 'undo'
          ? await window.csvViewer.undoCsvEdit({ sessionId: session.sessionId })
          : await window.csvViewer.redoCsvEdit({ sessionId: session.sessionId });
      setEditState(nextEditState);
      api?.refreshInfiniteCache();
      setSelectedRowIds([]);
    } catch (error) {
      const message = error instanceof Error ? error.message : `Unable to ${action} edit.`;
      setEditError(message);
    }
  }

  async function deleteSelectedRows() {
    const api = gridApiRef.current;

    if (selectedRowIds.length === 0) {
      return;
    }

    try {
      setEditError(null);
      setEditState(
        await window.csvViewer.deleteCsvRows({
          sessionId: session.sessionId,
          rowIds: selectedRowIds,
        }),
      );
      api?.deselectAll();
      setSelectedRowIds([]);
      api?.refreshInfiniteCache();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to delete selected rows.';
      setEditError(message);
    }
  }

  function onSelectionChanged(event: SelectionChangedEvent<CsvRow>) {
    setSelectedRowIds(
      event.api
        .getSelectedRows()
        .map((row) => row[csvInternalRowIdField])
        .filter((rowId) => rowId.length > 0),
    );
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
              {editState.dirty ? (
                <span className="rounded-sm bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900">
                  Unsaved changes
                </span>
              ) : null}
            </div>
            {editError ? <p className="mt-1 text-sm text-destructive">{editError}</p> : null}
          </div>
        </div>
        <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
          <QueryStatusBadge state={queryState} />
          <div className="flex shrink-0 items-center gap-1">
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => void deleteSelectedRows()}
              disabled={selectedRowIds.length === 0}
              title="Delete selected rows"
              aria-label="Delete selected rows"
            >
              <Trash2 />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => void runHistoryAction('undo')}
              disabled={!editState.canUndo}
              title="Undo edit"
              aria-label="Undo edit"
            >
              <Undo2 />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => void runHistoryAction('redo')}
              disabled={!editState.canRedo}
              title="Redo edit"
              aria-label="Redo edit"
            >
              <Redo2 />
            </Button>
          </div>
          <label className="sr-only" htmlFor="global-search">
            Global search
          </label>
          <div className="relative min-w-0 sm:w-[270px]">
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
            <Input
              id="global-search"
              className="w-full min-w-0 bg-card pr-3 pl-9"
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
      <div className="csv-grid-frame min-h-0 w-full" aria-label="CSV row grid">
        <AgGridReact<CsvRow>
          key={session.sessionId}
          theme={csvGridTheme}
          columnDefs={columnDefs}
          defaultColDef={{
            editable: true,
            cellEditor: 'agTextCellEditor',
            minWidth: 120,
          }}
          getRowId={(params) => params.data[csvInternalRowIdField]}
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
          onCellValueChanged={onCellValueChanged}
          onSelectionChanged={onSelectionChanged}
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
