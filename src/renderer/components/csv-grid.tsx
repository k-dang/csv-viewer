import { useEffect, useMemo, useRef, useState, type ComponentType } from 'react';
import { AgGridReact, type AgGridReactProps } from 'ag-grid-react';
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
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
  Database,
  FileDown,
  HardDrive,
  Plus,
  Redo2,
  RotateCcw,
  Search,
  Table2,
  Trash2,
  Undo2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import type {
  CsvEditState,
  CsvFilterDescriptor,
  CsvRow,
  WorkingCsvView,
} from '../../shared/csv-viewer-contract';
import { csvInternalRowIdField } from '../../shared/csv-viewer-contract';
import { createCsvGridDataSource, toCsvFilterDescriptors, type AgFilterModel } from './csv-grid-data-source';
import { formatCellValue, formatFileSize, formatNumber } from './csv-format';
import { QueryStatusBadge, type QueryState } from './query-status-badge';
import { CsvStatsPanel } from './csv-stats-panel';
import { resolveStatsColumnOnOpen } from './csv-stats-state';
import { useCsvViewer } from '../csv-viewer';

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

export type CsvGridProps = {
  workingCsv: WorkingCsvView;
  themeMode: 'light' | 'dark';
  exportRequestSequence?: number;
  onUnexportedChangesChange?: (hasUnexportedChanges: boolean) => void;
  DataGrid?: ComponentType<AgGridReactProps<CsvRow>>;
};

export function CsvGrid({
  workingCsv,
  themeMode,
  exportRequestSequence = 0,
  onUnexportedChangesChange,
  DataGrid = AgGridReact,
}: CsvGridProps) {
  const viewer = useCsvViewer();
  const gridApiRef = useRef<GridApi<CsvRow> | null>(null);
  const [filteredRowCount, setFilteredRowCount] = useState(workingCsv.rowCount);
  const [displayedTotalRowCount, setDisplayedTotalRowCount] = useState(workingCsv.rowCount);
  const [hasActiveQuery, setHasActiveQuery] = useState(false);
  const hasActiveQueryRef = useRef(false);
  const [queryState, setQueryState] = useState<QueryState>('idle');
  const [editState, setEditState] = useState<CsvEditState>(workingCsv.editState);
  const [editError, setEditError] = useState<string | null>(null);
  const [selectedRowIds, setSelectedRowIds] = useState<string[]>([]);
  const [search, setSearch] = useState('');
  const searchRef = useRef(search);
  const [statsPanelOpen, setStatsPanelOpen] = useState(false);
  const [statsColumn, setStatsColumn] = useState(workingCsv.columns[0]?.name ?? '');
  const [focusedColumn, setFocusedColumn] = useState<string | null>(null);
  const [statsFilters, setStatsFilters] = useState<CsvFilterDescriptor[]>([]);
  const [statsRefreshKey, setStatsRefreshKey] = useState(0);
  const requestStateRef = useRef({ latestRequestId: 0 });
  const workingCsvIdRef = useRef(workingCsv.workingCsvId);
  const revertingCellRef = useRef(false);
  const handledExportRequestSequenceRef = useRef(0);
  const columnDefs = useMemo<ColDef<CsvRow>[]>(
    () =>
      workingCsv.columns.map((column) => ({
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
        valueFormatter: ({ value }) => formatCellValue(value),
      })),
    [workingCsv.columns],
  );

  useEffect(() => {
    searchRef.current = search;
  }, [search]);

  useEffect(() => {
    onUnexportedChangesChange?.(editState.hasUnexportedChanges);
  }, [editState.hasUnexportedChanges, onUnexportedChangesChange]);

  useEffect(() => {
    if (exportRequestSequence <= handledExportRequestSequenceRef.current) return;
    handledExportRequestSequenceRef.current = exportRequestSequence;
    void exportCsv();
  }, [exportRequestSequence]);

  useEffect(() => {
    workingCsvIdRef.current = workingCsv.workingCsvId;
    setEditState(workingCsv.editState);
    setFilteredRowCount(workingCsv.rowCount);
    setDisplayedTotalRowCount(workingCsv.rowCount);
    setHasActiveQuery(false);
    hasActiveQueryRef.current = false;
    setEditError(null);
    setSelectedRowIds([]);
    setStatsPanelOpen(false);
    setStatsColumn(workingCsv.columns[0]?.name ?? '');
    setFocusedColumn(null);
    setStatsFilters([]);
    setStatsRefreshKey((current) => current + 1);
    void refreshEditState();
  }, [workingCsv]);

  function onGridReady(event: GridReadyEvent<CsvRow>) {
    gridApiRef.current = event.api;
    const datasource = createCsvGridDataSource(
      workingCsv,
      viewer,
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
      workingCsv,
      viewer,
      handleFilteredRowCount,
      search,
      requestStateRef.current,
      setQueryState,
    );
    api.setGridOption('datasource', datasource);
  }, [viewer, search, workingCsv]);

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
      workingCsv,
      viewer,
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
      const result = await viewer.call({
        operation: 'csv.edit-cell',
        workingCsvId: workingCsv.workingCsvId,
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
      event.node.setDataValue(column, event.oldValue);
      revertingCellRef.current = false;
    }
  }

  /** Responses that arrive after the grid moved to another Working CSV describe the old one. */
  async function refreshEditState() {
    const { workingCsvId } = workingCsv;
    try {
      const editState = await viewer.call({ operation: 'csv.get-edit-state', workingCsvId });
      if (workingCsvIdRef.current !== workingCsvId) return;
      setEditState(editState);
    } catch (error) {
      if (workingCsvIdRef.current !== workingCsvId) return;
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
          ? await viewer.call({ operation: 'csv.undo', workingCsvId: workingCsv.workingCsvId })
          : await viewer.call({ operation: 'csv.redo', workingCsvId: workingCsv.workingCsvId });
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
        await viewer.call({
          operation: 'csv.delete-rows',
          workingCsvId: workingCsv.workingCsvId,
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
        await viewer.call({
          operation: 'csv.insert-row',
          workingCsvId: workingCsv.workingCsvId,
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

  async function exportCsv() {
    try {
      setEditError(null);
      const result = await viewer.call({
        operation: 'csv.export',
        workingCsvId: workingCsv.workingCsvId,
      });

      if (result.status === 'cancelled') return;

      setEditState(result.editState);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to export CSV.';
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
    const column = event.column instanceof Object ? event.column.getColId() : event.column ?? undefined;

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
            columns: workingCsv.columns,
            currentColumn,
            focusedColumn,
          });
        });
      }

      return nextOpen;
    });
  }

  const hasSearch = search.trim().length > 0;
  const canClearQuery = hasActiveQuery || hasSearch || filteredRowCount !== workingCsv.rowCount;
  const canInsertRelative = !hasActiveQuery && selectedRowIds.length === 1;
  const canAppendRow = !hasActiveQuery && selectedRowIds.length === 0;

  return (
    <div className="grid min-h-0 grid-rows-[auto_1fr] overflow-hidden rounded-lg border bg-card shadow-sm">
      <div>
        <div className="flex min-h-[64px] flex-col gap-3 border-b bg-card/90 px-[18px] py-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <span
              className="grid size-9 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground"
              aria-hidden="true"
            >
              <Database className="size-4" />
            </span>
            <div className="min-w-0">
              <h2
                id="metadata-title"
                className="truncate text-base font-semibold text-foreground"
                title={workingCsv.source.name}
              >
                {workingCsv.source.name}
              </h2>
              <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-muted-foreground">
                <span>
                  {formatNumber(filteredRowCount)} visible of {formatNumber(displayedTotalRowCount)} rows
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <Table2 className="size-3.5" aria-hidden="true" />
                  {formatNumber(workingCsv.columns.length)} columns
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <HardDrive className="size-3.5" aria-hidden="true" />
                  {formatFileSize(workingCsv.source.sizeBytes)}
                </span>
                {editState.hasUnexportedChanges ? (
                  <span className="rounded-sm bg-amber-100 px-1.5 py-0.5 text-xs font-medium text-amber-900">
                    Unexported Changes
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
                onClick={() => void exportCsv()}
                title="Export CSV"
                aria-label="Export CSV"
              >
                <FileDown />
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
              <Search
                className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                aria-hidden="true"
              />
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
      </div>
      <div className="grid min-h-0 min-w-0 grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="csv-grid-frame min-h-0 w-full min-w-0" aria-label="CSV row grid">
          <DataGrid
            key={workingCsv.workingCsvId}
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
            rowSelection={{
              mode: 'multiRow',
              enableClickSelection: true,
              checkboxes: false,
              headerCheckbox: false,
            }}
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
            workingCsv={workingCsv}
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

function hasGridSortOrFilters(api: GridApi<CsvRow>): boolean {
  const hasSort = api.getColumnState().some((column) => Boolean(column.sort));
  const hasFilter = Object.keys(api.getFilterModel()).length > 0;
  return hasSort || hasFilter;
}

function getCsvFilters(api: GridApi<CsvRow>): CsvFilterDescriptor[] {
  // SAFETY: This grid only registers AG Grid's built-in text, number, and date filters.
  return toCsvFilterDescriptors(api.getFilterModel() as AgFilterModel);
}

function getColumnFilter(columnType: string): string {
  if (
    /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|DOUBLE|DECIMAL)/i.test(
      columnType,
    )
  ) {
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
