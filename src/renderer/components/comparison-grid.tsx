import { useEffect, useMemo, useRef } from 'react';
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
} from 'ag-grid-community';
import type {
  ComparisonColumnsMode,
  ComparisonRow,
  ComparisonRowsMode,
  ComparisonView,
} from '../../shared/csv-viewer-contract';
import { orderComparisonValueColumns } from '../../shared/comparison-presentation';
import {
  comparisonGridRequestBounds,
  createComparisonGridDataSource,
} from './comparison-grid-data-source';
import { useCsvViewerRuntime } from '../csv-viewer-runtime';

ModuleRegistry.registerModules([
  CellStyleModule,
  ColumnApiModule,
  InfiniteRowModelModule,
  RenderApiModule,
]);

type DisplayValue = {
  kind: 'value' | 'null' | 'empty' | 'missing';
  text: string;
  copyText: string;
  changed: boolean;
  side: 'baseline' | 'candidate';
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

export function ComparisonGrid({
  comparison,
  applied,
  rowsMode,
  columnsMode,
  themeMode,
}: {
  comparison: ComparisonView;
  applied: NonNullable<ComparisonView['applied']>;
  rowsMode: ComparisonRowsMode;
  columnsMode: ComparisonColumnsMode;
  themeMode: 'light' | 'dark';
}) {
  const runtime = useCsvViewerRuntime();
  const activeResultToken = useRef(applied.resultToken);
  useEffect(() => {
    activeResultToken.current = applied.resultToken;
  }, [applied.resultToken]);
  const changedCounts = useMemo(
    () =>
      new Map(
        applied.summary.changedColumns.map((column) => [column.name, column.changedRowCount]),
      ),
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
        cellClass: (params) =>
          params.value === 'changed' ? 'comparison-result-cell--changed' : undefined,
        cellRenderer: (params: ICellRendererParams<GridComparisonRow, string>) => {
          const value = String(params.value ?? '');
          const label = value.replace('-', ' ');
          return (
            <span className={`comparison-classification comparison-classification--${value}`}>
              {label}
            </span>
          );
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

  const dataSource = useMemo(
    () =>
      createComparisonGridDataSource(
        runtime,
        {
          comparisonId: comparison.comparisonId,
          resultToken: applied.resultToken,
          rows: rowsMode,
          columns: columnsMode,
        },
        () => activeResultToken.current,
        toGridRow,
      ),
    [applied.resultToken, columnsMode, comparison.comparisonId, rowsMode, runtime],
  );

  return (
    <div className="min-h-0 min-w-0 comparison-grid-frame" aria-label="Aligned comparison results">
      <AgGridReact<GridComparisonRow>
        key={`${applied.resultToken}:${rowsMode}:${columnsMode}:${comparison.baseline.workingCsvId}`}
        theme={themeMode === 'dark' ? darkTheme : lightTheme}
        rowModelType="infinite"
        datasource={dataSource}
        columnDefs={columnDefs}
        cacheBlockSize={comparisonGridRequestBounds.cacheBlockSize}
        maxBlocksInCache={comparisonGridRequestBounds.maxBlocksInCache}
        maxConcurrentDatasourceRequests={comparisonGridRequestBounds.maxConcurrentRequests}
        infiniteInitialRowCount={1}
        getRowId={(params) => params.data.rowKey}
        onCellKeyDown={(params) => {
          const event = params.event as KeyboardEvent | null;
          if (event?.key !== 'Enter' || !('value' in params) || !isDisplayValue(params.value)) {
            return;
          }
          event.preventDefault();
          copyComparisonValue(params.value.copyText);
        }}
        defaultColDef={{ resizable: true, sortable: false, minWidth: 120 }}
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
      return typeof value === 'object' && value !== null ? value : undefined;
    },
    headerName,
    minWidth: 160,
    cellClass: (params) => {
      const value = params.value;
      return value?.changed
        ? `comparison-cell comparison-cell--changed-${value.side}`
        : 'comparison-cell';
    },
    cellRenderer: (params: ICellRendererParams<GridComparisonRow, DisplayValue>) => {
      const value = params.value;
      if (!value) return null;
      return (
        <span className="group/cell flex w-full items-center gap-2">
          <span className="min-w-0 flex-1 truncate">
            <span className="sr-only">{value.changed ? `${value.side} changed value: ` : ''}</span>
            <span className={value.kind === 'value' ? '' : 'italic text-muted-foreground'}>
              {value.text}
            </span>
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

function isDisplayValue(value: unknown): value is DisplayValue {
  return typeof value === 'object' && value !== null && 'copyText' in value;
}

function toGridRow(row: ComparisonRow): GridComparisonRow {
  const result: GridComparisonRow = {
    rowKey: JSON.stringify(row.keyValues),
    classification: row.classification,
  };
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
  side: 'baseline' | 'candidate',
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
function columnField(index: number, side: 'baseline' | 'candidate') {
  return `${side}:${index}`;
}
