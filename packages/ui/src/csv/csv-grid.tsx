import { useEffect, useMemo, useRef, useSyncExternalStore, type ComponentType } from 'react';
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
  type IDatasource,
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
import type { CsvRow } from '@csv-viewer/workspace/csv-viewer';
import { csvInternalRowIdField } from '@csv-viewer/workspace/csv-viewer';
import type { CsvTab } from './csv-tab';
import { toCsvFilterDescriptors, toCsvSortDescriptors, type AgFilterModel } from './ag-grid-query';
import { formatCellValue, formatFileSize, formatNumber } from './csv-format';
import { QueryStatusBadge } from './query-status-badge';
import { CsvStatsPanel } from './csv-stats-panel';

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
  tab: CsvTab;
  themeMode: 'light' | 'dark';
  DataGrid?: ComponentType<AgGridReactProps<CsvRow>>;
};

/**
 * The row grid and toolbar of one CSV Tab. Every fact shown here is read from the Tab, and every
 * action is a Tab command; this view only translates AG Grid models and keeps the grid's own
 * caches and selection in step with the Tab.
 */
export function CsvGrid({ tab, themeMode, DataGrid = AgGridReact }: CsvGridProps) {
  const state = useSyncExternalStore(tab.subscribe, tab.snapshot);
  const { workingCsv, editState, editError, exportConfirmation, query, hasActiveQuery, selectedRowIds, stats } =
    state;
  const gridApiRef = useRef<GridApi<CsvRow> | null>(null);
  const revertingCellRef = useRef(false);

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

  // The grid's models are handed to the Tab right before each fetch, so the Tab's query is always
  // the one the visible rows were loaded with, and the Stats Panel follows the same query.
  const datasource = useMemo<IDatasource>(
    () => ({
      getRows: (params) => {
        // SAFETY: This grid only registers AG Grid's built-in text, number, and date filters.
        tab.setGridQuery(toCsvSortDescriptors(params.sortModel), toCsvFilterDescriptors(params.filterModel as AgFilterModel));
        tab
          .rows(params.startRow, Math.max(0, params.endRow - params.startRow))
          .then((window) => {
            if (window) params.successCallback(window.rows, window.filteredRowCount);
          })
          .catch(() => params.failCallback());
      },
    }),
    [tab],
  );

  // Edits, history steps, search changes, and Reopen CSV all change what the loaded blocks hold.
  useEffect(() => {
    gridApiRef.current?.refreshInfiniteCache();
  }, [state.revision, query.search]);

  // Reopen CSV starts the Tab's query over; the grid's own sort and filter state follows.
  useEffect(() => {
    const api = gridApiRef.current;
    if (!api) return;
    api.applyColumnState({ defaultState: { sort: null } });
    api.setFilterModel(null);
  }, [workingCsv]);

  // The Tab clears its selection after every mutation; the grid drops its highlighted rows too.
  useEffect(() => {
    if (selectedRowIds.length === 0) gridApiRef.current?.deselectAll();
  }, [selectedRowIds]);

  function onGridReady(event: GridReadyEvent<CsvRow>) {
    gridApiRef.current = event.api;
  }

  function clearQuery() {
    const api = gridApiRef.current;
    tab.clearQuery();
    if (!api) return;
    api.applyColumnState({ defaultState: { sort: null } });
    api.setFilterModel(null);
  }

  async function onCellValueChanged(event: CellValueChangedEvent<CsvRow>) {
    if (revertingCellRef.current) return;
    const rowId = event.data?.[csvInternalRowIdField];
    const column = event.colDef.field;
    if (!rowId || !column) return;

    const accepted = await tab.editCell(rowId, column, String(event.newValue ?? ''));
    if (accepted) return;
    revertingCellRef.current = true;
    event.node.setDataValue(column, event.oldValue);
    revertingCellRef.current = false;
  }

  function onSelectionChanged(event: SelectionChangedEvent<CsvRow>) {
    tab.setSelection(
      event.api
        .getSelectedRows()
        .map((row) => row[csvInternalRowIdField])
        .filter((rowId) => rowId.length > 0),
    );
  }

  function onCellFocused(event: CellFocusedEvent<CsvRow>) {
    const column = event.column instanceof Object ? event.column.getColId() : event.column ?? undefined;
    if (column) tab.setFocusedColumn(column);
  }

  const canClearQuery = hasActiveQuery || state.filteredRowCount !== workingCsv.rowCount;
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
                  {formatNumber(state.filteredRowCount)} visible of {formatNumber(state.totalRowCount)} rows
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
              {exportConfirmation ? (
                <p className="mt-1 text-sm font-medium text-emerald-700" role="status">
                  {exportConfirmation}
                </p>
              ) : null}
            </div>
          </div>
          <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
            <QueryStatusBadge state={state.queryStatus} />
            <div className="flex shrink-0 items-center gap-1">
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => void tab.insertRow('above')}
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
                onClick={() => void tab.insertRow('below')}
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
                onClick={() => void tab.insertRow('append')}
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
                onClick={() => void tab.deleteSelectedRows()}
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
                onClick={() => void tab.export()}
                title="Export CSV"
                aria-label="Export CSV"
              >
                <FileDown />
              </Button>
              <Button
                type="button"
                variant="outline"
                size="icon"
                onClick={() => void tab.undo()}
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
                onClick={() => void tab.redo()}
                disabled={!editState.canRedo}
                title="Redo edit"
                aria-label="Redo edit"
              >
                <Redo2 />
              </Button>
              <Button
                type="button"
                variant={stats.open ? 'default' : 'outline'}
                size="icon"
                onClick={() => tab.toggleStats()}
                title={stats.open ? 'Close stats panel' : 'Open stats panel'}
                aria-label={stats.open ? 'Close stats panel' : 'Open stats panel'}
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
                value={query.search}
                onChange={(event) => tab.setSearch(event.target.value)}
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
            datasource={datasource}
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
            overlayNoRowsTemplate="<span class='ag-overlay-loading-center'>No rows match the current query.</span>"
          />
        </div>
        {stats.open ? <CsvStatsPanel tab={tab} /> : null}
      </div>
    </div>
  );
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
