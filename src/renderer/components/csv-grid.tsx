import { useEffect, useMemo, useRef, useState } from 'react';
import { AgGridReact } from 'ag-grid-react';
import {
  CellApiModule,
  type CellFocusedEvent,
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
import { ArrowDown, ArrowUp, BarChart3, Database, HardDrive, Plus, Redo2, RotateCcw, Save, Search, Table2, Trash2, Undo2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type { CsvCellValue, CsvEditState, CsvFilterDescriptor, CsvRow, CsvSessionMetadata } from '../../shared/ipc';
import { csvInternalRowIdField } from '../../shared/ipc';
import { createCsvGridDataSource, toCsvFilterDescriptors, type AgFilterModel } from './csv-grid-data-source';
import { formatCellValue, formatFileSize, formatNumber } from './csv-format';
import { QueryStatusBadge, type QueryState } from './query-status-badge';
import { CsvStatsPanel } from './csv-stats-panel';
import { resolveStatsColumnOnOpen } from './csv-stats-state';

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

const csvGridLightTheme = themeQuartz.withParams({
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

const csvGridDarkTheme = themeQuartz.withParams({
  accentColor: '#5eead4',
  backgroundColor: '#171717',
  borderColor: '#3f3f46',
  browserColorScheme: 'dark',
  cellFontSize: 13,
  chromeBackgroundColor: '#202020',
  fontFamily: 'Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  fontSize: 13,
  foregroundColor: '#f5f5f5',
  headerBackgroundColor: '#262626',
  headerFontSize: 13,
  headerFontWeight: 700,
  headerTextColor: '#fafafa',
  iconSize: 15,
  oddRowBackgroundColor: '#1f1f1f',
  rowHeight: 38,
  selectedRowBackgroundColor: 'rgba(94, 234, 212, 0.16)',
  spacing: 7,
  wrapperBorder: false,
  wrapperBorderRadius: 8,
});

const filterDebounceMs = 1500;

export function CsvGrid({
  session,
  themeMode,
  onDirtyChange,
}: {
  session: CsvSessionMetadata;
  themeMode: 'light' | 'dark';
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const gridApiRef = useRef<GridApi<CsvRow> | null>(null);
  const [filteredRowCount, setFilteredRowCount] = useState(session.rowCount);
  const [displayedTotalRowCount, setDisplayedTotalRowCount] = useState(session.rowCount);
  const [hasActiveQuery, setHasActiveQuery] = useState(false);
  const hasActiveQueryRef = useRef(false);
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
  const [statsPanelOpen, setStatsPanelOpen] = useState(false);
  const [statsColumn, setStatsColumn] = useState(session.columns[0]?.name ?? '');
  const [focusedColumn, setFocusedColumn] = useState<string | null>(null);
  const [statsFilters, setStatsFilters] = useState<CsvFilterDescriptor[]>([]);
  const [statsRefreshKey, setStatsRefreshKey] = useState(0);
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
    onDirtyChange?.(editState.dirty);
  }, [editState.dirty, onDirtyChange]);

  useEffect(() => {
    setEditState({
      sessionId: session.sessionId,
      dirty: false,
      canUndo: false,
      canRedo: false,
    });
    setFilteredRowCount(session.rowCount);
    setDisplayedTotalRowCount(session.rowCount);
    setHasActiveQuery(false);
    hasActiveQueryRef.current = false;
    setEditError(null);
    setSelectedRowIds([]);
    setStatsPanelOpen(false);
    setStatsColumn(session.columns[0]?.name ?? '');
    setFocusedColumn(null);
    setStatsFilters([]);
    setStatsRefreshKey((current) => current + 1);
    void refreshEditState();
  }, [session.sessionId]);

  function onGridReady(event: GridReadyEvent<CsvRow>) {
    gridApiRef.current = event.api;
    const datasource = createCsvGridDataSource(
      session,
      window.csvViewer,
      handleFilteredRowCount,
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

    updateActiveQueryState(hasGridSortOrFilters(api) || search.trim().length > 0);
    setStatsFilters(getCsvFilters(api));
    setStatsRefreshKey((current) => current + 1);
    const datasource = createCsvGridDataSource(
      session,
      window.csvViewer,
      handleFilteredRowCount,
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
    setStatsFilters([]);
    setStatsRefreshKey((current) => current + 1);
    setFilteredRowCount(displayedTotalRowCount);
    updateActiveQueryState(false);
    const datasource = createCsvGridDataSource(
      session,
      window.csvViewer,
      handleFilteredRowCount,
      '',
      requestStateRef.current,
      setQueryState,
    );
    api.setGridOption('datasource', datasource);
  }

  function refreshQuery(event: { api: GridApi<CsvRow> }) {
    updateActiveQueryState(hasGridSortOrFilters(event.api) || searchRef.current.trim().length > 0);
    setStatsFilters(getCsvFilters(event.api));
    setStatsRefreshKey((current) => current + 1);
    event.api.refreshInfiniteCache();
  }

  function updateActiveQueryState(nextHasActiveQuery: boolean) {
    hasActiveQueryRef.current = nextHasActiveQuery;
    setHasActiveQuery(nextHasActiveQuery);
  }

  function handleFilteredRowCount(rowCount: number) {
    setFilteredRowCount(rowCount);

    if (!hasActiveQueryRef.current) {
      setDisplayedTotalRowCount(rowCount);
    }
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
      setStatsRefreshKey((current) => current + 1);
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
      setStatsRefreshKey((current) => current + 1);
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
      setStatsRefreshKey((current) => current + 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to delete selected rows.';
      setEditError(message);
    }
  }

  async function insertRow(placement: 'above' | 'below' | 'append') {
    const api = gridApiRef.current;

    try {
      setEditError(null);
      setEditState(
        await window.csvViewer.insertCsvRow({
          sessionId: session.sessionId,
          placement,
          rowIds: selectedRowIds,
          hasActiveQuery,
        }),
      );
      api?.deselectAll();
      setSelectedRowIds([]);
      api?.refreshInfiniteCache();
      setStatsRefreshKey((current) => current + 1);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to insert row.';
      setEditError(message);
    }
  }

  async function saveAs() {
    try {
      setEditError(null);
      const result = await window.csvViewer.saveCsvAs({ sessionId: session.sessionId });

      if (isCancelledSaveResult(result)) {
        return;
      }

      setEditState(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to save CSV.';
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

  function onCellFocused(event: CellFocusedEvent<CsvRow>) {
    const column = typeof event.column === 'string' ? event.column : event.column?.getColId();

    if (column) {
      setFocusedColumn(column);
    }
  }

  function toggleStatsPanel() {
    setStatsPanelOpen((open) => {
      const nextOpen = !open;

      if (nextOpen) {
        setStatsColumn((currentColumn) => {
          return resolveStatsColumnOnOpen({
            columns: session.columns,
            currentColumn,
            focusedColumn,
          });
        });
      }

      return nextOpen;
    });
  }

  const hasSearch = search.trim().length > 0;
  const canClearQuery = hasActiveQuery || hasSearch || filteredRowCount !== session.rowCount;
  const canInsertRelative = !hasActiveQuery && selectedRowIds.length === 1;
  const canAppendRow = !hasActiveQuery && selectedRowIds.length === 0;

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
              <span>{formatNumber(filteredRowCount)} visible of {formatNumber(displayedTotalRowCount)} rows</span>
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
              onClick={() => void insertRow('above')}
              disabled={!canInsertRelative}
              title="Insert row above"
              aria-label="Insert row above"
            >
              <ArrowUp />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => void insertRow('below')}
              disabled={!canInsertRelative}
              title="Insert row below"
              aria-label="Insert row below"
            >
              <ArrowDown />
            </Button>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => void insertRow('append')}
              disabled={!canAppendRow}
              title="Append row"
              aria-label="Append row"
            >
              <Plus />
            </Button>
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
              onClick={() => void saveAs()}
              disabled={!editState.dirty}
              title="Save CSV as"
              aria-label="Save CSV as"
            >
              <Save />
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
            <Button
              type="button"
              variant={statsPanelOpen ? 'default' : 'outline'}
              size="icon"
              onClick={toggleStatsPanel}
              title={statsPanelOpen ? 'Close stats panel' : 'Open stats panel'}
              aria-label={statsPanelOpen ? 'Close stats panel' : 'Open stats panel'}
            >
              <BarChart3 />
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
      <div className="grid min-h-0 min-w-0 grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="csv-grid-frame min-h-0 w-full min-w-0" aria-label="CSV row grid">
          <AgGridReact<CsvRow>
            key={session.sessionId}
            theme={themeMode === 'dark' ? csvGridDarkTheme : csvGridLightTheme}
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
            onCellFocused={onCellFocused}
            onSortChanged={refreshQuery}
            onFilterChanged={refreshQuery}
            overlayNoRowsTemplate="<span class='ag-overlay-loading-center'>No rows match the current query.</span>"
          />
        </div>
        {statsPanelOpen && statsColumn ? (
          <CsvStatsPanel
            session={session}
            selectedColumn={statsColumn}
            filters={statsFilters}
            search={search.trim()}
            refreshKey={statsRefreshKey}
            onColumnChange={setStatsColumn}
            onClose={() => setStatsPanelOpen(false)}
          />
        ) : null}
      </div>
    </div>
  );
}

function isCancelledSaveResult(
  result: CsvEditState | { status: 'cancelled' },
): result is { status: 'cancelled' } {
  return 'status' in result && result.status === 'cancelled';
}

function hasGridSortOrFilters(api: GridApi<CsvRow>): boolean {
  const hasSort = api.getColumnState().some((column) => Boolean(column.sort));
  const hasFilter = Object.keys(api.getFilterModel()).length > 0;
  return hasSort || hasFilter;
}

function getCsvFilters(api: GridApi<CsvRow>): CsvFilterDescriptor[] {
  return toCsvFilterDescriptors(api.getFilterModel() as AgFilterModel);
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
