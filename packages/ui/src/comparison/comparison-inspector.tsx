import { useSyncExternalStore } from 'react';
import { ArrowLeft, ArrowRight, Copy, Loader2 } from 'lucide-react';
import type { ComparisonSide, ComparisonView } from '@csv-viewer/workspace/csv-viewer';
import { Button } from '@/components/ui/button';
import { copyCell } from '../csv/copy-column';
import { ComparisonRowList } from './comparison-row-list';
import type { ComparisonRowsViewState } from './comparison-rows';
import { ComparisonValue, ComparisonClassification, comparisonKeyLabel, comparisonFields } from './comparison-values';
import type { ComparisonTab } from './comparison-tab';

export function ComparisonInspector({ tab, applied, viewState, focusDetail }: {
  tab: ComparisonTab;
  applied: NonNullable<ComparisonView['applied']>;
  viewState: ComparisonRowsViewState;
  focusDetail: boolean;
}) {
  const { selection, selectionLoading, totalRows, changedOnly } = useSyncExternalStore(tab.subscribe, tab.snapshot);
  const fields = comparisonFields(applied.summary);
  const visibleFields = changedOnly && selection?.row.changed.some(Boolean)
    ? fields.filter(field => selection.row.changed[field.index]) : fields;

  return (
    <div className="comparison-inspector">
      <aside aria-label="Choose a comparison row" className="comparison-inspector-list">
        <p className="border-b px-3 py-2 text-xs text-muted-foreground">{totalRows === null ? 'Loading rows…' : `${totalRows.toLocaleString()} ${totalRows === 1 ? 'row' : 'rows'} · select to inspect`}</p>
        <ComparisonRowList tab={tab} applied={applied} viewState={viewState} />
      </aside>
      <section ref={element => { if (focusDetail) element?.focus(); }} tabIndex={-1} aria-label="Selected comparison row" className="comparison-detail outline-none">
        {selection ? (
          <>
            <header className="comparison-detail-header">
              <div className="min-w-0">
                <h2 className="break-words font-mono text-sm font-semibold">{comparisonKeyLabel(applied.key, selection.row.keyValues)}</h2>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <ComparisonClassification classification={selection.row.classification} />
                  <span className="text-xs text-muted-foreground">Row {selection.index + 1} of {totalRows?.toLocaleString()}</span>
                  {selectionLoading ? <Loader2 aria-label="Loading selected row" className="size-3 animate-spin" /> : null}
                </div>
              </div>
              <div className="ml-auto flex shrink-0 gap-1">
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Previous row"
                  disabled={selection.index === 0 || selectionLoading}
                  onClick={() => void tab.selectIndex(selection.index - 1)}
                >
                  <ArrowLeft />
                </Button>
                <Button
                  variant="outline"
                  size="icon-sm"
                  aria-label="Next row"
                  disabled={totalRows === null || selection.index + 1 >= totalRows || selectionLoading}
                  onClick={() => void tab.selectIndex(selection.index + 1)}
                >
                  <ArrowRight />
                </Button>
              </div>
            </header>
            <div className="min-h-0 overflow-auto">
              {fields.length === 0 ? <p className="p-6 text-sm text-muted-foreground">This comparison contains only key columns.</p> : (
                <table className="comparison-detail-table">
                  <thead>
                    <tr>
                      <th scope="col">Field</th>
                      <th scope="col">Baseline</th>
                      <th scope="col">Candidate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleFields.map(field => (
                      <tr key={field.name}>
                        <th scope="row">{field.name}</th>
                        {(['baseline', 'candidate'] satisfies ComparisonSide[]).map(side => {
                          const data = selection.row[side];
                          return (
                            <td key={side}>
                              {data ? (
                                <div className="flex items-center gap-1">
                                  <ComparisonValue
                                    value={data.values[field.index]}
                                    side={side}
                                    changed={selection.row.changed[field.index] || !selection.row.baseline || !selection.row.candidate}
                                  />
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    aria-label={`Copy ${side} value for ${field.name}`}
                                    onClick={() => void copyCell(field.name, data.values[field.index])}
                                  >
                                    <Copy className="size-3" />
                                  </Button>
                                </div>
                              ) : <span className="text-xs italic text-muted-foreground">Row absent</span>}
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </>
        ) : <div className="grid flex-1 place-items-center p-8 text-sm text-muted-foreground">Loading a row to inspect…</div>}
      </section>
    </div>
  );
}
