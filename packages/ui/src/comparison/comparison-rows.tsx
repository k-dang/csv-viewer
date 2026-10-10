import { useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import { AgGridReact } from 'ag-grid-react';
import {
  ColumnApiModule, InfiniteRowModelModule, ModuleRegistry, RenderApiModule, ScrollApiModule, RowStyleModule,
  type ColDef, type ColumnState, type GridApi, type IDatasource,
} from 'ag-grid-community';
import type { ComparisonRow } from '@csv-viewer/workspace/csv-viewer';
import { gridTheme } from '@/lib/grid-theme';
import { comparisonPageSize, type ComparisonTab } from './comparison-tab';

ModuleRegistry.registerModules([
  ColumnApiModule, InfiniteRowModelModule, RenderApiModule, ScrollApiModule, RowStyleModule,
]);

export type GridComparisonRow = { row: ComparisonRow; index: number; queryVersion: number };

/** View presentation survives unmounting; row pages belong only to the active grid. */
export type ComparisonRowsViewState = {
  columns?: ColumnState[];
  scroll?: { top: number; left: number; queryVersion: number; selectedKey: string | null };
};

export function ComparisonRows({ tab, viewState, columnDefs, onChoose, label, rowHeight, headerHeight, className = '', resizable = false }: {
  tab: ComparisonTab;
  viewState: ComparisonRowsViewState;
  columnDefs: ColDef<GridComparisonRow>[];
  onChoose: (data: GridComparisonRow) => void;
  label: string;
  rowHeight: number;
  headerHeight: number;
  className?: string;
  resizable?: boolean;
}) {
  const { comparison, queryVersion, selection } = useSyncExternalStore(tab.subscribe, tab.snapshot);
  const apiRef = useRef<GridApi<GridComparisonRow> | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const selectedKey = selection ? JSON.stringify(selection.row.keyValues) : null;
  const selectedKeyRef = useRef(selectedKey);
  selectedKeyRef.current = selectedKey;
  const savedScroll = useRef(viewState.scroll?.queryVersion === queryVersion ? viewState.scroll : undefined);
  const previousQueryVersion = useRef(queryVersion);
  const previousResultToken = useRef(comparison.applied?.resultToken);
  const datasource = useMemo<IDatasource>(() => ({
    getRows: params => {
      const version = tab.snapshot().queryVersion;
      tab.rows(params.startRow, params.endRow - params.startRow).then(window => {
        if (!window || tab.snapshot().queryVersion !== version) {
          params.failCallback();
          return;
        }
        tab.receiveRows(window, version);
        params.successCallback(window.rows.map((row, index) => ({ row, index: window.offset + index, queryVersion: version })), window.totalRowCount);
      }).catch(() => {
        tab.rowsFailed(version);
        params.failCallback();
      });
    },
  }), [tab]);

  useEffect(() => {
    if (previousQueryVersion.current === queryVersion) return;
    previousQueryVersion.current = queryVersion;
    const api = apiRef.current;
    if (!api || api.isDestroyed()) return;
    const replacing = previousResultToken.current !== comparison.applied?.resultToken;
    previousResultToken.current = comparison.applied?.resultToken;
    if (!replacing) api.ensureIndexVisible(0, 'top');
    // Refresh retains displayed rows until their replacements arrive; a new datasource purges them.
    api.refreshInfiniteCache();
  }, [queryVersion, comparison.applied?.resultToken]);

  useEffect(() => {
    const api = apiRef.current;
    if (!api || api.isDestroyed()) return;
    api.redrawRows();
    if (selection) api.ensureIndexVisible(selection.index);
  }, [selectedKey, selection?.index]);

  return (
    <div ref={frameRef} className={`min-h-0 min-w-0 comparison-grid-frame ${className}`}>
      <AgGridReact<GridComparisonRow>
        theme={gridTheme}
        rowModelType="infinite"
        datasource={datasource}
        columnDefs={columnDefs}
        defaultColDef={{ resizable, sortable: false, suppressMovable: true }}
        headerHeight={headerHeight}
        rowHeight={rowHeight}
        cacheBlockSize={comparisonPageSize}
        maxBlocksInCache={6}
        maxConcurrentDatasourceRequests={2}
        infiniteInitialRowCount={Math.max(1, Math.ceil((savedScroll.current?.top ?? 0) / rowHeight) + comparisonPageSize)}
        getRowId={params => JSON.stringify(params.data.row.keyValues)}
        getRowClass={params => params.data && JSON.stringify(params.data.row.keyValues) === selectedKeyRef.current ? 'comparison-selected-row' : undefined}
        onGridReady={event => {
          apiRef.current = event.api;
          event.api.setGridAriaProperty('label', label);
          if (viewState.columns) event.api.applyColumnState({ state: viewState.columns });
        }}
        onGridPreDestroyed={event => {
          viewState.columns = event.api.getColumnState();
          if (viewState.scroll) viewState.scroll.selectedKey = selectedKeyRef.current;
        }}
        onBodyScroll={event => {
          viewState.scroll = {
            top: event.top,
            left: event.left,
            queryVersion,
            selectedKey: selectedKeyRef.current,
          };
        }}
        onFirstDataRendered={event => {
          // AG Grid's GridState omits scroll for the infinite row model.
          const scroll = savedScroll.current;
          if (scroll) {
            const vertical = frameRef.current?.querySelector('.ag-body-viewport');
            const center = frameRef.current?.querySelector('.ag-center-cols-viewport');
            const horizontal = frameRef.current?.querySelector('.ag-body-horizontal-scroll-viewport');
            if (vertical) vertical.scrollTop = scroll.top;
            // Restore both before layout can sync the scrollbar from the row viewport.
            if (center) center.scrollLeft = scroll.left;
            if (horizontal) horizontal.scrollLeft = scroll.left;
          }
          const current = tab.snapshot().selection;
          if (current && (!scroll || scroll.selectedKey !== selectedKeyRef.current)) event.api.ensureIndexVisible(current.index);
        }}
        onRowClicked={event => {
          const current = tab.snapshot();
          if (event.data && !current.rowsLoading && event.data.queryVersion === current.queryVersion) onChoose(event.data);
        }}
        onCellKeyDown={params => {
          const event = params.event;
          const current = tab.snapshot();
          if (!(event instanceof KeyboardEvent) || event.key !== 'Enter' || !params.data || current.rowsLoading || params.data.queryVersion !== current.queryVersion) return;
          event.preventDefault();
          onChoose(params.data);
        }}
        overlayLoadingTemplate="<span class='ag-overlay-loading-center'>Loading comparison rows…</span>"
      />
    </div>
  );
}
