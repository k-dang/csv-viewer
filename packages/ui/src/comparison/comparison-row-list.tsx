import type { ICellRendererParams } from 'ag-grid-community';
import type { ComparisonView } from '@csv-viewer/workspace/csv-viewer';
import { ComparisonRows, type ComparisonRowsViewState, type GridComparisonRow } from './comparison-rows';
import { ComparisonClassification, comparisonKeyLabel } from './comparison-values';
import type { ComparisonTab } from './comparison-tab';

export function ComparisonRowList({ tab, applied, viewState }: {
  tab: ComparisonTab;
  applied: NonNullable<ComparisonView['applied']>;
  viewState: ComparisonRowsViewState;
}) {
  return (
    <ComparisonRows
      key={applied.resultToken}
      tab={tab}
      viewState={viewState}
      columnDefs={[{
        colId: 'key', minWidth: 150, flex: 1,
        cellRenderer: (params: ICellRendererParams<GridComparisonRow>) => params.data ? (
          <div className="comparison-row-identity">
            <span className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-xs">{comparisonKeyLabel(applied.key, params.data.row.keyValues)}</span>
              <span className="text-xs text-muted-foreground">{params.data.row.changed.filter(Boolean).length || ''}</span>
            </span>
            <ComparisonClassification classification={params.data.row.classification} />
            <span className="sr-only">Select this row.</span>
          </div>
        ) : null,
      }]}
      onChoose={({ row, index }) => tab.selectRow(row, index)}
      label="Comparison rows"
      headerHeight={0}
      rowHeight={64}
      className="comparison-row-list"
    />
  );
}
