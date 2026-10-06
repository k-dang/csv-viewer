import { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from 'react';
import { AgGridReact, type AgGridReactProps } from 'ag-grid-react';
import {
  CellApiModule,
  type CellContextMenuEvent,
  type CellFocusedEvent,
  type CellKeyDownEvent,
  CellStyleModule,
  ColumnApiModule,
  CustomFilterModule,
  DateFilterModule,
  InfiniteRowModelModule,
  ModuleRegistry,
  NumberFilterModule,
  RenderApiModule,
  RowApiModule,
  RowSelectionModule,
  TextEditorModule,
  type CellValueChangedEvent,
  type ColDef,
  type ColumnMovedEvent,
  type GridApi,
  type GridReadyEvent,
  type IDatasource,
  type ICellEditorParams,
  type SelectionChangedEvent,
} from 'ag-grid-community';
import {
  ArrowDown,
  ArrowUp,
  BarChart3,
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
import type { CsvFilterDescriptor, CsvRow, CsvSortDescriptor } from '@csv-viewer/workspace/csv-viewer';
import { csvInternalRowIdField } from '@csv-viewer/workspace/csv-viewer';
import type { CsvTab } from './csv-tab';
import { copyCell, isCopyCellShortcut } from './copy-column';
import { toAgFilterModel, toAgSortState, toCsvFilterDescriptors, toCsvSortDescriptors, type AgFilterModel } from './ag-grid-query';
import { formatCellValue, formatFileSize, formatNumber } from './csv-format';
import { QueryStatusIndicator } from './query-status-indicator';
import { CsvStatsPanel } from './csv-stats-panel';
import { CsvColumnMenu } from './csv-column-menu';
import { CsvExportControls } from './csv-export-controls';
import { CsvValueFilter, type CsvValueFilterParams } from './csv-value-filter';
import { CsvCellMenu, type CellMenuTarget } from './csv-cell-menu';
import { setValuePicked, valueFilter, type ValueFilterModel, type ValuePick } from './value-filter-model';

ModuleRegistry.registerModules([
  CellApiModule,
  CellStyleModule,
  ColumnApiModule,
  CustomFilterModule,
  DateFilterModule,
  InfiniteRowModelModule,
  NumberFilterModule,
  RenderApiModule,
  RowApiModule,
  RowSelectionModule,
  TextEditorModule,
]);

const filterDebounceMs = 1500;

const rowSelection: AgGridReactProps<CsvRow>['rowSelection'] = {
  mode: 'multiRow',
  enableClickSelection: true,
  checkboxes: false,
  headerCheckbox: false,
};

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
  const gridFrameId = useId();
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
  const pendingCellCommit = useRef<Promise<boolean> | null>(null);
  const failedCellEdit = useRef<{ rowId: string; column: string; value: string } | null>(null);
  const [cellMenu, setCellMenu] = useState<CellMenuTarget | null>(null);
  const [cellMenuOpen, setCellMenuOpen] = useState(false);

  const columnDefs = useMemo<ColDef<CsvRow>[]>(
    () =>
      workingCsv.columns.map((column) => ({
        field: column.name,
        headerName: column.name,
        minWidth: getColumnMinWidth(column.type),
        resizable: true,
        sortable: true,
        ...columnFilter(column.type, tab),
        suppressMovable: false,
        cellClassRules: {
          'csv-cell-empty': (params) => params.value === '',
          'csv-cell-null': (params) => params.value === null || params.value === undefined,
        },
        valueFormatter: ({ value }) => formatCellValue(value),
      })),
    [workingCsv.columns, tab],
  );

  // Stable across renders: a new defaultColDef makes AG Grid refresh its headers, which closes an
  // open filter popup on every Tab state change.
  const defaultColDef = useMemo<ColDef<CsvRow>>(
    () => ({
      editable: true,
      cellEditor: 'agTextCellEditor',
      cellEditorParams: (params: ICellEditorParams<CsvRow>) => {
        const failed = failedCellEdit.current;
        return failed && failed.rowId === params.data?.[csvInternalRowIdField] && failed.column === params.column.getColId()
          ? { value: failed.value } : {};
      },
      minWidth: 120,
    }),
    [],
  );

  // The grid's models are handed to the Tab right before each fetch, so the Tab's query is always
  // the one the visible rows were loaded with, and the Stats Panel follows the same query.
  const datasource = useMemo<IDatasource>(
    () => ({
      getRows: (params) => {
        // SAFETY: This grid only registers the Value Filter and AG Grid's built-in number and date filters.
        tab.setGridQuery(toCsvSortDescriptors(params.sortModel), toCsvFilterDescriptors(params.filterModel as AgFilterModel));
        tab
          .rows(params.startRow, Math.max(0, params.endRow - params.startRow))
          .then((window) => {
            // A superseded window must still answer: AG Grid holds a loader slot per open request.
            if (window) params.successCallback(window.rows, window.filteredRowCount);
            else params.failCallback();
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
    applyGridQuery(api, query.sort, query.filters);
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
    applyGridQuery(api, [], []);
  }, [workingCsv.workingCsvId, workingCsv.dataRevision]);

  // The Tab clears its selection after every mutation; the grid drops its highlighted rows too.
  useEffect(() => {
    if (selectedRowIds.length === 0) gridApiRef.current?.deselectAll();
  }, [selectedRowIds]);

  function onGridReady(event: GridReadyEvent<CsvRow>) {
    gridApiRef.current = event.api;
  }

  async function onColumnMoved(event: ColumnMovedEvent<CsvRow>) {
    if (!event.finished || event.source !== 'uiColumnMoved') return;
    const current = tab.snapshot().workingCsv.columns.map((column) => column.name);
    const known = new Set(current);
    const names = event.api.getColumnState().flatMap((column) =>
      column.colId && known.has(column.colId) ? [column.colId] : [],
    );
    const permutation = names.length === current.length && new Set(names).size === current.length;
    if (permutation && names.every((name, index) => name === current[index])) return;
    if (permutation && await tab.reorderColumns(names)) return;
    event.api.applyColumnState({
      state: current.map((colId) => ({ colId })),
      applyOrder: true,
    });
  }

  function clearQuery() {
    const api = gridApiRef.current;
    tab.clearQuery();
    if (!api) return;
    applyGridQuery(api, [], []);
  }

  async function onCellValueChanged(event: CellValueChangedEvent<CsvRow>) {
    if (event.source === 'csv-viewer-revert') return;
    const rowId = event.data?.[csvInternalRowIdField];
    const column = event.colDef.field;
    if (!rowId || !column) return;

    const accepted = await commitCell(rowId, column, String(event.newValue ?? ''));
    if (accepted) { failedCellEdit.current = null; return; }
    failedCellEdit.current = { rowId, column, value: String(event.newValue ?? '') };
    event.node.setDataValue(column, event.oldValue, 'csv-viewer-revert');
    if (event.rowIndex !== null) event.api.startEditingCell({ rowIndex: event.rowIndex, colKey: column });
  }

  async function commitCell(rowId: string, column: string, value: string): Promise<boolean> {
    const commit = tab.editCell(rowId, column, value);
    pendingCellCommit.current = commit;
    const accepted = await commit;
    if (pendingCellCommit.current === commit) pendingCellCommit.current = null;
    return accepted;
  }

  async function commitEditing(): Promise<boolean> {
    if (pendingCellCommit.current && !(await pendingCellCommit.current)) return false;
    const api = gridApiRef.current;
    const cell = api?.getEditingCells()[0];
    if (!api || !cell) return true;
    const row = api.getDisplayedRowAtIndex(cell.rowIndex)?.data;
    const editor = api.getCellEditorInstances({ columns: [cell.colId] })[0];
    if (!row || !editor) return false;
    // Commit the draft before moving focus; rejected writes leave the editor intact.
    const value = String(editor.getValue() ?? '');
    const accepted = value === String(row[cell.colId] ?? '')
      || await commitCell(row[csvInternalRowIdField], cell.colId, value);
    if (accepted) {
      failedCellEdit.current = null;
      // A slow write must not discard text typed, or another editor opened, while it awaited.
      if (api.getCellEditorInstances({ columns: [cell.colId] })[0] !== editor || String(editor.getValue() ?? '') !== value) return false;
      api.stopEditing(true);
    }
    return accepted;
  }

  async function exportView() {
    if (!(await commitEditing())) return;
    syncGridQuery();
    if (tab.snapshot().queryStatus !== 'ready') return;
    await tab.exportView();
  }

  function syncGridQuery() {
    const api = gridApiRef.current;
    if (api) {
      const sorted = api.getColumnState().filter((column) => column.sort)
        .sort((a, b) => (a.sortIndex ?? 0) - (b.sortIndex ?? 0));
      const sort = sorted.flatMap((column) => column.sort === 'asc' || column.sort === 'desc'
        ? [{ column: column.colId, direction: column.sort }] : []);
      // SAFETY: The grid registers only the Value Filter and the built-in number and date filters.
      tab.setGridQuery(sort, toCsvFilterDescriptors(api.getFilterModel() as AgFilterModel));
    }
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

  // Cells of Value Filter columns open the Cell Menu. Other cells, and a right-click over selected
  // text, keep the browser's own menu.
  function onCellContextMenu({ event, column, value }: CellContextMenuEvent<CsvRow>) {
    if (!(event instanceof MouseEvent) || window.getSelection()?.isCollapsed === false) return;
    if (column.getColDef().filter !== CsvValueFilter) return;
    event.preventDefault();
    setCellMenu({ column: column.getColId(), value: value ?? null, point: DOMRect.fromRect({ x: event.clientX, y: event.clientY }) });
    setCellMenuOpen(true);
  }

  /** Keeps or hides one exact value through the column's Value Filter, leaving its search term. */
  async function filterCellValue({ column, value }: CellMenuTarget, keep: boolean) {
    const api = gridApiRef.current;
    if (!api) return;
    const current = api.getColumnFilterModel<ValueFilterModel>(column);
    const pick: ValuePick | undefined = keep ? { operator: 'in', values: [value] } : setValuePicked(current?.pick, value, false);
    await api.setColumnFilterModel(column, valueFilter(current?.contains ?? '', pick));
    api.onFilterChanged();
  }

  // Ctrl+C copies the focused cell's raw value (null as empty). An open editor and text the user
  // selected across cells keep the browser's own copy. Ctrl+Shift+A lives on the Column Menu.
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
          <CsvExportControls tab={tab} commitEditing={commitEditing} exportView={exportView} />
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
        <div id={gridFrameId} className="csv-grid-frame min-h-0 w-full min-w-0" aria-label="CSV row grid">
          {focusedColumn ? (
            // Scope the tint to this grid; inactive CSV Tabs keep their grids and styles mounted.
            <style>{`#${CSS.escape(gridFrameId)} [col-id="${CSS.escape(focusedColumn)}"] { background-color: color-mix(in oklch, var(--primary) 7%, transparent); }`}</style>
          ) : null}
          <CsvColumnMenu tab={tab} active={active}>
            <DataGrid
              key={workingCsv.workingCsvId}
              theme={gridTheme}
              columnDefs={columnDefs}
              defaultColDef={defaultColDef}
              getRowId={(params) => params.data[csvInternalRowIdField]}
              rowModelType="infinite"
              datasource={datasource}
              cacheBlockSize={100}
              maxBlocksInCache={6}
              rowBuffer={8}
              rowSelection={rowSelection}
              enableCellTextSelection
              ensureDomOrder
              suppressDragLeaveHidesColumns
              onGridReady={onGridReady}
              onColumnMoved={onColumnMoved}
                onCellValueChanged={onCellValueChanged}
                onSortChanged={syncGridQuery}
                onFilterChanged={syncGridQuery}
              onSelectionChanged={onSelectionChanged}
              onCellFocused={onCellFocused}
              onCellKeyDown={onCellKeyDown}
              onCellContextMenu={onCellContextMenu}
              overlayNoRowsTemplate="<span class='ag-overlay-loading-center'>No rows match the current query.</span>"
            />
          </CsvColumnMenu>
          <CsvCellMenu
            target={cellMenu}
            open={cellMenuOpen}
            onOpenChange={setCellMenuOpen}
            onFilter={(target, keep) => void filterCellValue(target, keep)}
          />
        </div>
        {stats.open ? <CsvStatsPanel tab={tab} /> : null}
      </div>
      <div className="flex h-8 min-w-0 items-center gap-3 border-t bg-muted/40 px-3 text-xs">
        <QueryStatusIndicator state={state.queryStatus} />
        <Separator orientation="vertical" className="h-4 self-center" />
        {focusedColumn ? (
          <span className="flex min-w-0 flex-1 items-center gap-2">
            <span className="min-w-0 truncate font-semibold text-foreground">{focusedColumn}</span>
            <span className="shrink-0 text-muted-foreground">
              {formatNumber(state.filteredRowCount)} {state.filteredRowCount === 1 ? 'value' : 'values'}
            </span>
          </span>
        ) : (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">Right-click a column header to edit the column.</span>
        )}
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

/**
 * Pushes a sort and filter state onto the grid. Filters go first: a sort change rebuilds AG Grid's
 * row cache from the filter model it holds at that moment, and the Value Filter's model would
 * otherwise still be the old one.
 */
function applyGridQuery(api: GridApi<CsvRow>, sort: CsvSortDescriptor[], filters: CsvFilterDescriptor[]): void {
  api.setFilterModel(toAgFilterModel(filters));
  api.applyColumnState({ state: toAgSortState(sort), defaultState: { sort: null } });
}

function filterKind(columnType: string): 'number' | 'date' | 'text' {
  if (
    /^(TINYINT|SMALLINT|INTEGER|BIGINT|HUGEINT|UTINYINT|USMALLINT|UINTEGER|UBIGINT|FLOAT|DOUBLE|DECIMAL)/i.test(
      columnType,
    )
  ) {
    return 'number';
  }

  if (/^(DATE|TIMESTAMP|TIMESTAMP_TZ|TIME)/i.test(columnType)) {
    return 'date';
  }

  return 'text';
}

/** Number and date columns use AG Grid's own filters; text columns use the Value Filter. */
function columnFilter(columnType: string, tab: CsvTab): Pick<ColDef<CsvRow>, 'filter' | 'filterParams'> {
  switch (filterKind(columnType)) {
    case 'number':
      return { filter: 'agNumberColumnFilter', filterParams: { debounceMs: filterDebounceMs } };
    case 'date':
      return { filter: 'agDateColumnFilter', filterParams: { debounceMs: filterDebounceMs } };
    case 'text':
      return { filter: CsvValueFilter, filterParams: { tab } satisfies CsvValueFilterParams };
  }
}

function getColumnMinWidth(columnType: string): number {
  return filterKind(columnType) === 'date' ? 180 : 140;
}
