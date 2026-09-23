import { useEffect, useMemo, useRef, useSyncExternalStore, type ComponentType, type ReactNode } from 'react';
import { AgGridReact, type AgGridReactProps } from 'ag-grid-react';
import {
  CellApiModule,
  type CellFocusedEvent,
  type CellKeyDownEvent,
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
  FileDown,
  Plus,
  Redo2,
  RotateCcw,
  Search,
  Trash2,
  Undo2,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { gridTheme } from '@/lib/grid-theme';
import type { CsvRow } from '@csv-viewer/workspace/csv-viewer';
import { csvInternalRowIdField } from '@csv-viewer/workspace/csv-viewer';
import type { CsvTab } from './csv-tab';
import { copyCell, isCopyCellShortcut } from './copy-column';
import { toAgFilterModel, toAgSortState, toCsvFilterDescriptors, toCsvSortDescriptors, type AgFilterModel } from './ag-grid-query';
import { formatCellValue, formatFileSize, formatNumber } from './csv-format';
import { QueryStatusIndicator } from './query-status-indicator';
import { CsvStatsPanel } from './csv-stats-panel';
import { CsvColumnBar } from './csv-column-bar';

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

const filterDebounceMs = 1500;

export type CsvGridProps = {
  tab: CsvTab;
  /** Workspace commands about this file (Reopen, Compare), shown at the start of its toolbar. */
  fileActions?: ReactNode;
  /** Inactive tabs stay mounted but hidden; only the active one answers window shortcuts. */
  active: boolean;
  DataGrid?: ComponentType<AgGridReactProps<CsvRow>>;
};

/**
 * The toolbar, row grid, and status bar of one CSV Tab. Every fact shown here is read from the Tab, and every
 * action is a Tab command; this view only translates AG Grid models and keeps the grid's own
 * caches and selection in step with the Tab.
 */
export function CsvGrid({ tab, fileActions, active, DataGrid = AgGridReact }: CsvGridProps) {
  const state = useSyncExternalStore(tab.subscribe, tab.snapshot);
  const {
    workingCsv,
    editState,
    editError,
    exportConfirmation,
    query,
    hasActiveQuery,
    selectedRowIds,
    focusedColumn,
    stats,
  } = state;
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

  // A header rename is a new AG Grid colId. After AG Grid accepts the new defs, push the Tab's
  // already-remapped sort and filter onto that id, then refetch.
  useEffect(() => {
    const api = gridApiRef.current;
    if (!api) return;
    api.applyColumnState({ state: toAgSortState(query.sort), defaultState: { sort: null } });
    api.setFilterModel(toAgFilterModel(query.filters));
  }, [workingCsv.columns]);

  // Edits, history steps, search changes, and Reopen CSV all change what the loaded blocks hold.
  useEffect(() => {
    gridApiRef.current?.refreshInfiniteCache();
  }, [state.revision, query.search]);

  // Reopen CSV starts the Tab's query over; the grid's own sort and filter state follows.
  // Column patches reuse the Working CSV id and the open-time dataRevision, so those two keys
  // change on open and Reopen CSV only.
  useEffect(() => {
    const api = gridApiRef.current;
    if (!api) return;
    api.applyColumnState({ defaultState: { sort: null } });
    api.setFilterModel(null);
  }, [workingCsv.workingCsvId, workingCsv.dataRevision]);

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

  // Ctrl+C copies the focused cell's raw value (null as empty). An open editor and text the user
  // selected across cells keep the browser's own copy. Ctrl+Shift+A lives on the Column Bar.
  function onCellKeyDown({ event, api, column, value }: CellKeyDownEvent<CsvRow>) {
    if (!event || !isCopyCellShortcut(event)) return;
    if (api.getEditingCells().length > 0 || window.getSelection()?.isCollapsed === false) return;
    event.preventDefault();
    void copyCell(column.getColId(), value);
  }

  const canClearQuery = hasActiveQuery || state.filteredRowCount !== workingCsv.rowCount;
  const canInsertRelative = selectedRowIds.length === 1;
  const canAppendRow = !hasActiveQuery && selectedRowIds.length === 0;

  return (
    <div className="csv-view grid min-h-0 min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] bg-card">
      <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 border-b px-4 py-2">
        <div className="min-w-0 max-w-72">
          <h2 id="metadata-title" className="truncate text-sm font-semibold text-foreground" title={workingCsv.source.name}>
            {workingCsv.source.name}
          </h2>
          <div className="flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground">
            <span>{formatNumber(workingCsv.columns.length)} columns</span>
            <span aria-hidden="true">·</span>
            <span>{formatFileSize(workingCsv.source.sizeBytes)}</span>
            {editState.hasUnexportedChanges ? (
              <span className="ml-1 rounded-sm bg-amber-100 px-1.5 font-medium text-amber-900 dark:bg-amber-400/15 dark:text-amber-200">
                Unexported Changes
              </span>
            ) : null}
          </div>
        </div>
        <div className="flex min-w-56 flex-1 items-center gap-1">
          <label className="sr-only" htmlFor="global-search">
            Global search
          </label>
          <div className="relative min-w-0 flex-1 md:max-w-lg">
            <Search
              className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              id="global-search"
              className="h-8 w-full min-w-0 bg-background pr-3 pl-8"
              type="search"
              value={query.search}
              onChange={(event) => tab.setSearch(event.target.value)}
              placeholder="Search all columns"
            />
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            onClick={clearQuery}
            disabled={!canClearQuery}
            title="Clear query"
            aria-label="Clear query"
          >
            <RotateCcw />
          </Button>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {fileActions}
          {fileActions ? <Separator orientation="vertical" className="mx-1 h-5 self-center" /> : null}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => void tab.insertRow('above')}
                disabled={!canInsertRelative}
                title="Insert row above"
                aria-label="Insert row above"
              >
                <ArrowUp />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => void tab.insertRow('below')}
                disabled={!canInsertRelative}
                title="Insert row below"
                aria-label="Insert row below"
              >
                <ArrowDown />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => void tab.insertRow('append')}
                disabled={!canAppendRow}
                title="Append row"
                aria-label="Append row"
              >
                <Plus />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => void tab.deleteSelectedRows()}
                disabled={selectedRowIds.length === 0}
                title="Delete selected rows"
                aria-label="Delete selected rows"
              >
                <Trash2 />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => void tab.undo()}
                disabled={!editState.canUndo}
                title="Undo edit"
                aria-label="Undo edit"
              >
                <Undo2 />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                onClick={() => void tab.redo()}
                disabled={!editState.canRedo}
                title="Redo edit"
                aria-label="Redo edit"
              >
                <Redo2 />
              </Button>
          <Separator orientation="vertical" className="mx-1 h-5 self-center" />
          <Button type="button" variant="outline" size="sm" onClick={() => void tab.export()} aria-label="Export CSV">
            <FileDown />
            Export
          </Button>
          <Button
            type="button"
            variant={stats.open ? 'default' : 'ghost'}
            size="icon-sm"
            onClick={() => tab.toggleStats()}
            title={stats.open ? 'Close stats panel' : 'Open stats panel'}
            aria-label={stats.open ? 'Close stats panel' : 'Open stats panel'}
          >
            <BarChart3 />
          </Button>
        </div>
      </div>
      <div className="grid min-h-0 min-w-0 grid-cols-1 md:grid-cols-[minmax(0,1fr)_auto]">
        <div className="csv-grid-frame min-h-0 w-full min-w-0" aria-label="CSV row grid">
          {focusedColumn ? (
            // Tints the Column Bar's column without rebuilding columnDefs on every focus change.
            <style>{`.csv-grid-frame [col-id="${CSS.escape(focusedColumn)}"] { background-color: color-mix(in oklch, var(--primary) 7%, transparent); }`}</style>
          ) : null}
          <DataGrid
            key={workingCsv.workingCsvId}
            theme={gridTheme}
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
            onGridReady={onGridReady}
            onCellValueChanged={onCellValueChanged}
            onSelectionChanged={onSelectionChanged}
            onCellFocused={onCellFocused}
            onCellKeyDown={onCellKeyDown}
            overlayNoRowsTemplate="<span class='ag-overlay-loading-center'>No rows match the current query.</span>"
          />
        </div>
        {stats.open ? <CsvStatsPanel tab={tab} /> : null}
      </div>
      <div className="flex h-8 min-w-0 items-center gap-3 border-t bg-muted/40 px-3 text-xs">
        <QueryStatusIndicator state={state.queryStatus} />
        <Separator orientation="vertical" className="h-4 self-center" />
        <CsvColumnBar tab={tab} active={active} />
        {editError ? (
          <span className="min-w-0 truncate text-destructive" role="alert" title={editError}>
            {editError}
          </span>
        ) : null}
        {exportConfirmation ? (
          <span className="shrink-0 font-medium text-emerald-700 dark:text-emerald-400" role="status">
            {exportConfirmation}
          </span>
        ) : null}
        <span className="ml-auto shrink-0 text-muted-foreground tabular-nums">
          {formatNumber(state.filteredRowCount)} visible of {formatNumber(state.totalRowCount)} rows
        </span>
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
