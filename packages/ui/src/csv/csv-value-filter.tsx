import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useGridFilter, type CustomFilterProps } from 'ag-grid-react';
import { Loader2, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { FieldError } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { topCountedValuesLimit, type CsvRow } from '@csv-viewer/workspace/csv-viewer';
import type { CsvTab, CsvTabQuery, CsvTabStatsResult } from './csv-tab';
import { formatCellValue, formatNumber } from './csv-format';
import {
  isValuePicked,
  selectAllState,
  setValuePicked,
  valueFilter,
  type ValueFilterModel,
  type ValuePick,
} from './value-filter-model';

/** Typing settles this long before the search term filters rows and narrows the value list. */
const searchDebounceMs = 300;

export type CsvValueFilterParams = { tab: CsvTab };

type CountsResult = Exclude<CsvTabStatsResult, { status: 'loading' }>;

/**
 * The column filter popup on text columns. The search field keeps rows containing its text and
 * narrows the list below it; the list holds the column's Top Counted Values under every other
 * active filter and search, each with a checkbox that keeps or hides that exact value.
 */
export function CsvValueFilter({
  model,
  onModelChange,
  column,
  tab,
}: CustomFilterProps<CsvRow, unknown, ValueFilterModel> & CsvValueFilterParams) {
  const columnName = column.getColId();
  const searchRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  useGridFilter({
    doesFilterPass: useCallback(() => true, []),
    afterGuiAttached: useCallback(() => {
      setOpen(true);
      searchRef.current?.focus();
    }, []),
    afterGuiDetached: useCallback(() => setOpen(false), []),
  });

  const latestModel = useRef(model);
  latestModel.current = model;
  const pick = model?.pick;
  const [search, setSearch] = useState(model?.contains ?? '');
  const pendingSearch = useRef<number | null>(null);
  // The last model this popup committed. Any other model was set elsewhere (Clear query, Reopen
  // CSV, the cell menu): it replaces the term and drops a draft still waiting on its debounce.
  const ownModel = useRef(JSON.stringify(model ?? null));
  useEffect(() => {
    const incoming = JSON.stringify(model ?? null);
    if (incoming === ownModel.current) return;
    ownModel.current = incoming;
    cancelPendingSearch();
    setSearch(model?.contains ?? '');
  }, [model]);
  useEffect(() => () => cancelPendingSearch(), []);

  function cancelPendingSearch() {
    if (pendingSearch.current !== null) window.clearTimeout(pendingSearch.current);
    pendingSearch.current = null;
  }

  function commit(contains: string, nextPick: ValuePick | undefined) {
    cancelPendingSearch();
    const next = valueFilter(contains, nextPick);
    ownModel.current = JSON.stringify(next);
    onModelChange(next);
  }

  function onSearchChange(value: string) {
    setSearch(value);
    cancelPendingSearch();
    pendingSearch.current = window.setTimeout(() => commit(value, latestModel.current?.pick), searchDebounceMs);
  }

  const result = useFilterValueCounts(tab, columnName, open);
  const allState = selectAllState(pick);

  return (
    <div className="flex w-72 flex-col gap-2 p-2" aria-label={`Filter ${columnName}`} role="group">
      <div className="relative">
        <Search
          className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted-foreground"
          aria-hidden="true"
        />
        <Input
          ref={searchRef}
          // Not type="search": Escape closes the popup and must not also clear the term.
          type="text"
          role="searchbox"
          aria-label="Search values"
          placeholder="Search values"
          className="h-8 bg-background pl-8"
          value={search}
          onChange={(event) => onSearchChange(event.target.value)}
        />
      </div>
      <div className="flex flex-col">
        <ValueOption
          label="Select all"
          checked={allState === 'all'}
          indeterminate={allState === 'some'}
          onCheckedChange={(checked) => commit(search, checked ? undefined : { operator: 'in', values: [] })}
        />
        <Separator className="my-1" />
        <div className="max-h-64 overflow-y-auto" role="list" aria-label="Values">
          {result === null ? (
            <p className="flex items-center gap-2 px-1.5 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" aria-hidden="true" />
              Loading values
            </p>
          ) : result.status === 'failed' ? (
            <FieldError className="px-1.5 py-2">{result.message}</FieldError>
          ) : result.counts.values.length === 0 ? (
            <p className="px-1.5 py-2 text-sm text-muted-foreground">No matching values</p>
          ) : (
            result.counts.values.map(({ value, count }) => (
              <ValueOption
                key={value ?? '\u0000null'}
                role="listitem"
                label={formatCellValue(value)}
                labelClassName={value === null ? 'csv-cell-null' : value === '' ? 'csv-cell-empty' : undefined}
                count={count}
                checked={isValuePicked(pick, value)}
                onCheckedChange={(checked) => commit(search, setValuePicked(pick, value, checked))}
              />
            ))
          )}
        </div>
        {result?.status === 'ready' && result.counts.values.length >= topCountedValuesLimit ? (
          <p className="px-1.5 pt-2 text-xs text-muted-foreground">
            Showing the top {formatNumber(topCountedValuesLimit)} values. Search to find others.
          </p>
        ) : null}
      </div>
      <div className="flex justify-end border-t pt-2">
        <Button
          type="button"
          variant="ghost"
          size="xs"
          disabled={model === null && search === ''}
          onClick={() => {
            setSearch('');
            commit('', undefined);
          }}
        >
          Clear filter
        </Button>
      </div>
    </div>
  );
}

/**
 * Faceted counts for the open popup. Refetches when the list's scope or the data changes, so
 * picking a value in this column does not recount; keeps the last list on screen while the next
 * one loads so the popup does not flicker.
 */
function useFilterValueCounts(tab: CsvTab, column: string, open: boolean): CountsResult | null {
  // Narrow subscriptions: the Tab replaces `query` only when it changes, so focus, selection, and
  // status updates do not re-render mounted filters.
  const query = useSyncExternalStore(tab.subscribe, () => tab.snapshot().query);
  const revision = useSyncExternalStore(tab.subscribe, () => tab.snapshot().revision);
  const [result, setResult] = useState<CountsResult | null>(null);
  const scope = valueFilterScope(query, column);
  const scopeKey = JSON.stringify([scope, revision]);

  useEffect(() => {
    if (!open) return;
    let current = true;
    void (async () => {
      try {
        const counts = await tab.valueCounts(column, scope);
        if (current) setResult({ status: 'ready', counts });
      } catch (error) {
        if (current) setResult({
          status: 'failed',
          message: error instanceof Error ? error.message : 'Unable to load column values.',
        });
      }
    })();
    return () => {
      current = false;
    };
  }, [tab, column, open, scopeKey]);

  return result;
}

/**
 * The query a column's Value Filter list is counted under: the Tab's query without that column's
 * own pick, so values the pick hides stay listed and can be picked again.
 */
function valueFilterScope(query: CsvTabQuery, column: string): Pick<CsvTabQuery, 'filters' | 'search'> {
  return {
    filters: query.filters.filter((filter) => filter.column !== column || filter.kind !== 'values'),
    search: query.search.trim(),
  };
}

function ValueOption({
  label,
  count,
  checked,
  indeterminate = false,
  labelClassName,
  role,
  onCheckedChange,
}: {
  label: string;
  count?: number;
  checked: boolean;
  indeterminate?: boolean;
  /** The grid's own null and empty cell styling, so those values read the same in the list. */
  labelClassName?: string;
  role?: 'listitem';
  onCheckedChange: (checked: boolean) => void;
}) {
  return (
    <label
      role={role}
      className="flex min-w-0 cursor-pointer items-center gap-2 rounded-sm px-1.5 py-1 text-sm hover:bg-accent hover:text-accent-foreground"
    >
      <input
        type="checkbox"
        className="size-3.5 shrink-0 accent-primary"
        checked={checked}
        ref={(input) => {
          if (input) input.indeterminate = indeterminate;
        }}
        onChange={(event) => onCheckedChange(event.target.checked)}
      />
      <span className={cn('min-w-0 flex-1 truncate', labelClassName)} title={label}>
        {label}
      </span>
      {count === undefined ? null : (
        <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{formatNumber(count)}</span>
      )}
    </label>
  );
}
