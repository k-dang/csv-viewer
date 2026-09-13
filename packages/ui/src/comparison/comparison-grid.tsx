import { useMemo, useSyncExternalStore } from 'react';
import { AgGridReact } from 'ag-grid-react';
import {
  CellStyleModule,
  ColumnApiModule,
  InfiniteRowModelModule,
  ModuleRegistry,
  RenderApiModule,
  themeQuartz,
  type ColDef,
  type ColGroupDef,
  type ICellRendererParams,
  type IDatasource,
} from 'ag-grid-community';
import type { ComparisonRow, ComparisonSide, ComparisonView } from '@csv-viewer/workspace/csv-viewer';
import { orderComparisonValueColumns } from '@csv-viewer/workspace/comparison-presentation';
import type { ComparisonTab } from './comparison-tab';

ModuleRegistry.registerModules([CellStyleModule, ColumnApiModule, InfiniteRowModelModule, RenderApiModule]);

type DisplayValue = {
  kind: 'value' | 'null' | 'empty' | 'missing';
  text: string;
  copyText: string;
  changed: boolean;
  side: ComparisonSide;
};

type GridComparisonRow = {
  rowKey: string;
  classification: ComparisonRow['classification'];
  [field: string]: string | DisplayValue | null;
};

const lightTheme = themeQuartz.withParams({
  accentColor: '#0f766e',
  rowHeight: 40,
  wrapperBorder: false,
  wrapperBorderRadius: 0,
});
const defaultColDef: ColDef = { resizable: true, sortable: false, minWidth: 120 };
const darkTheme = themeQuartz.withParams({
  accentColor: '#5eead4',
  browserColorScheme: 'dark',
  backgroundColor: '#171717',
  foregroundColor: '#f5f5f5',
  headerBackgroundColor: '#262626',
  borderColor: '#3f3f46',
  rowHeight: 40,
  wrapperBorder: false,
  wrapperBorderRadius: 0,
});

/** The result grid of one Comparison Tab. Rows come from the Tab; only AG Grid translation lives here. */
export function ComparisonGrid({
  tab,
  applied,
  themeMode,
}: {
  tab: ComparisonTab;
  applied: NonNullable<ComparisonView['applied']>;
  themeMode: 'light' | 'dark';
}) {
  const { comparison, rows: rowsMode, columns: columnsMode } = useSyncExternalStore(tab.subscribe, tab.snapshot);
  const changedCounts = useMemo(
    () => new Map(applied.summary.changedColumns.map((column) => [column.name, column.changedRowCount])),
    [applied.summary.changedColumns],
  );
  const valueColumns = useMemo(
    () =>
      orderComparisonValueColumns(
        comparison.baseline.columns,
        applied.key,
        applied.summary.changedColumns,
        columnsMode,
      ),
    [applied.key, applied.summary.changedColumns, columnsMode, comparison.baseline.columns],
  );

  const columnDefs = useMemo<Array<ColDef<GridComparisonRow> | ColGroupDef<GridComparisonRow>>>(
    () => [
      {
        field: 'classification',
        headerName: 'Result',
        pinned: 'left',
        lockPinned: true,
        width: 132,
        cellClass: (params) => (params.value === 'changed' ? 'comparison-result-cell--changed' : undefined),
        cellRenderer: (params: ICellRendererParams<GridComparisonRow, string>) => {
          const value = String(params.value ?? '');
          const label = value.replace('-', ' ');
          return <span className={`comparison-classification comparison-classification--${value}`}>{label}</span>;
        },
      },
      ...applied.key.map(
        (column, index): ColDef<GridComparisonRow> => ({
          field: keyField(index),
          headerName: column,
          pinned: 'left',
          lockPinned: true,
          width: 150,
        }),
      ),
      ...valueColumns.map(
        (column, index): ColGroupDef<GridComparisonRow> => ({
          headerName: `${column} · ${changedCounts.get(column) ?? 0} changed`,
          marryChildren: true,
          children: [
            valueColumn(`${columnField(index, 'baseline')}`, 'Baseline'),
            valueColumn(`${columnField(index, 'candidate')}`, 'Candidate'),
          ],
        }),
      ),
    ],
    [applied.key, changedCounts, valueColumns],
  );

  // The grid remounts on every result or view-mode change (see `key`), so one datasource serves
  // one result under one view mode; the Tab drops windows that arrive after either moved on.
  const datasource = useMemo<IDatasource>(
    () => ({
      getRows: (params) => {
        tab
          .rows(params.startRow, params.endRow - params.startRow)
          .then((window) => {
            if (window) params.successCallback(window.rows.map(toGridRow), window.totalRowCount);
            else params.failCallback();
          })
          .catch(() => params.failCallback());
      },
    }),
    [tab],
  );

  return (
    <div className="min-h-0 min-w-0 comparison-grid-frame" aria-label="Aligned comparison results">
      <AgGridReact<GridComparisonRow>
        key={`${applied.resultToken}:${rowsMode}:${columnsMode}:${comparison.baseline.workingCsvId}`}
        theme={themeMode === 'dark' ? darkTheme : lightTheme}
        rowModelType="infinite"
        datasource={datasource}
        columnDefs={columnDefs}
        cacheBlockSize={100}
        maxBlocksInCache={6}
        maxConcurrentDatasourceRequests={2}
        infiniteInitialRowCount={1}
        getRowId={(params) => params.data.rowKey}
        onCellKeyDown={(params) => {
          const event = params.event;
          if (!(event instanceof KeyboardEvent)) return;
          if (event.key !== 'Enter' || !('value' in params) || !isDisplayValue(params.value)) {
            return;
          }
          event.preventDefault();
          copyComparisonValue(params.value.copyText);
        }}
        defaultColDef={defaultColDef}
        overlayLoadingTemplate="<span class='ag-overlay-loading-center'>Loading comparison rows…</span>"
      />
    </div>
  );
}

function valueColumn(field: string, headerName: string): ColDef<GridComparisonRow, DisplayValue> {
  return {
    colId: field,
    valueGetter: (params) => {
      const value = params.data?.[field];
      return isDisplayValue(value) ? value : undefined;
    },
    headerName,
    minWidth: 160,
    cellClass: (params) => {
      const value = params.value;
      return value?.changed ? `comparison-cell comparison-cell--changed-${value.side}` : 'comparison-cell';
    },
    cellRenderer: (params: ICellRendererParams<GridComparisonRow, DisplayValue>) => {
      const value = params.value;
      if (!value) return null;
      return (
        <span className="group/cell flex w-full items-center gap-2">
          <span className="min-w-0 flex-1 truncate">
            <span className="sr-only">{value.changed ? `${value.side} changed value: ` : ''}</span>
            <span className={value.kind === 'value' ? '' : 'italic text-muted-foreground'}>{value.text}</span>
            <span className="sr-only">. Press Enter to copy this value.</span>
          </span>
          <button
            type="button"
            className="opacity-0 group-hover/cell:opacity-100 focus:opacity-100"
            aria-label={`Copy ${value.side} value`}
            tabIndex={-1}
            onClick={() => copyComparisonValue(value.copyText)}
          >
            Copy
          </button>
        </span>
      );
    },
  };
}

function copyComparisonValue(value: string): void {
  void navigator.clipboard.writeText(value).catch(() => undefined);
}

function isDisplayValue(value: GridComparisonRow[string] | undefined): value is DisplayValue {
  if (value === null || value === undefined) return false;
  return Object.getOwnPropertyDescriptor(Object(value), 'copyText') !== undefined;
}

function toGridRow(row: ComparisonRow) {
  const result: GridComparisonRow = Object.create(null);
  result.rowKey = JSON.stringify(row.keyValues);
  result.classification = row.classification;
  row.keyValues.forEach((value, index) => {
    result[keyField(index)] = value;
  });
  row.changed.forEach((changed, index) => {
    result[columnField(index, 'baseline')] = displayValue(
      row.baseline?.values[index],
      !row.baseline,
      changed,
      'baseline',
    );
    result[columnField(index, 'candidate')] = displayValue(
      row.candidate?.values[index],
      !row.candidate,
      changed,
      'candidate',
    );
  });
  return result;
}

function displayValue(
  value: string | null | undefined,
  missing: boolean,
  changed: boolean,
  side: ComparisonSide,
): DisplayValue {
  if (missing)
    return {
      kind: 'missing',
      text: `Missing ${side} row`,
      copyText: `Missing ${side} row`,
      changed: false,
      side,
    };
  if (value === null) return { kind: 'null', text: 'Null', copyText: 'Null', changed, side };
  if (value === '') return { kind: 'empty', text: 'Empty string', copyText: '', changed, side };
  return { kind: 'value', text: value ?? '', copyText: value ?? '', changed, side };
}

function keyField(index: number) {
  return `key:${index}`;
}
function columnField(index: number, side: ComparisonSide) {
  return `${side}:${index}`;
}
