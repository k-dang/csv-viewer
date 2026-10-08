import { useMemo, useSyncExternalStore } from 'react';
import type { ColDef, ICellRendererParams } from 'ag-grid-community';
import { ArrowUpRight } from 'lucide-react';
import type { ComparisonView } from '@csv-viewer/workspace/csv-viewer';
import { ComparisonRows, type ComparisonRowsViewState, type GridComparisonRow } from './comparison-rows';
import { ComparisonValue, ComparisonClassification, comparisonKeyLabel, comparisonFields } from './comparison-values';
import type { ComparisonTab } from './comparison-tab';

export function ComparisonGrid({ tab, applied, viewState }: {
  tab: ComparisonTab;
  applied: NonNullable<ComparisonView['applied']>;
  viewState: ComparisonRowsViewState;
}) {
  const { changedOnly } = useSyncExternalStore(tab.subscribe, tab.snapshot);
  const columns = useMemo<ColDef<GridComparisonRow>[]>(() => {
    const allColumns = comparisonFields(applied.summary);
    const valueColumns = changedOnly && allColumns.some(column => column.changedRowCount > 0)
      ? allColumns.filter(column => column.changedRowCount > 0)
      : allColumns;
    return [
      {
        colId: 'key', headerName: 'Row', pinned: 'left', lockPinned: true,
        initialWidth: 185, minWidth: 125,
        cellRenderer: (params: ICellRendererParams<GridComparisonRow>) => params.data ? (
          <div className="comparison-row-identity">
            <span className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-xs">{comparisonKeyLabel(applied.key, params.data.row.keyValues)}</span>
              <ArrowUpRight className="size-3 text-primary" />
            </span>
            <span className="sr-only">Press Enter to inspect this row.</span>
          </div>
        ) : null,
      },
      {
        colId: 'classification', headerName: 'Result', initialWidth: 125, minWidth: 110,
        cellRenderer: (params: ICellRendererParams<GridComparisonRow>) => params.data
          ? <ComparisonClassification classification={params.data.row.classification} /> : null,
      },
      ...valueColumns.map(({ name, changedRowCount, index }): ColDef<GridComparisonRow> => ({
        colId: `value:${name}`,
        headerName: `${name}${changedRowCount ? ` · ${changedRowCount} Δ` : ''}`,
        initialWidth: 245, minWidth: 145,
        cellRenderer: (params: ICellRendererParams<GridComparisonRow>) => {
          const row = params.data?.row;
          if (!row) return null;
          const changed = row.changed[index];
          if (!changed && row.baseline && row.candidate) {
            return <ComparisonValue value={row.baseline.values[index]} side="baseline" changed={false} compact />;
          }
          return (
            <span className="comparison-inline-diff">
              {row.baseline ? <ComparisonValue value={row.baseline.values[index]} side="baseline" changed compact /> : null}
              {row.baseline && row.candidate ? <span aria-hidden="true" className="text-muted-foreground">→</span> : null}
              {row.candidate ? <ComparisonValue value={row.candidate.values[index]} side="candidate" changed compact /> : null}
            </span>
          );
        },
      })),
    ];
  }, [applied.key, applied.summary, changedOnly]);
  return (
    <ComparisonRows
      tab={tab}
      viewState={viewState}
      columnDefs={columns}
      onChoose={({ row, index }) => tab.inspectRow(row, index)}
      label="Aligned comparison results"
      headerHeight={38}
      rowHeight={44}
      resizable
    />
  );
}
