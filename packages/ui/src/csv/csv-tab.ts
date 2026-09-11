import type { QueryState } from './query-status-badge';
import type {
  CsvColumnValueCounts,
  CsvEditState,
  CsvFilterDescriptor,
  CsvInsertRowPlacement,
  CsvRowWindow,
  CsvSortDescriptor,
  CsvViewer,
  WorkingCsvView,
} from '@csv-viewer/workspace/csv-viewer';

/** The one query that shapes both the row window and the Count Scope of a CSV Tab. */
export type CsvTabQuery = {
  sort: CsvSortDescriptor[];
  filters: CsvFilterDescriptor[];
  search: string;
};

export type CsvTabStatsResult =
  | { status: 'loading' }
  | { status: 'ready'; counts: CsvColumnValueCounts }
  | { status: 'failed'; message: string };

export type CsvTabStats = {
  open: boolean;
  /** The Stats Column. Kept while the Stats Panel is closed so reopening restores it. */
  column: string;
  result: CsvTabStatsResult | null;
};

export type CsvTabState = {
  workingCsv: WorkingCsvView;
  editState: CsvEditState;
  editError: string | null;
  /** The runtime's own wording after a successful Export CSV. Cleared by the next change. */
  exportConfirmation: string | null;
  query: CsvTabQuery;
  /** True while sort, filters, or search shape the row window. Row insertion is blocked then. */
  hasActiveQuery: boolean;
  queryStatus: QueryState;
  filteredRowCount: number;
  /** The count shown as the total. Follows the row window while no query is active. */
  totalRowCount: number;
  /** Bumps on every change the row grid must refetch for: edits, history steps, Reopen CSV. */
  revision: number;
  selectedRowIds: string[];
  focusedColumn: string | null;
  stats: CsvTabStats;
};

const emptyQuery: CsvTabQuery = { sort: [], filters: [], search: '' };

/**
 * One CSV Tab: the per-Tab state of a Working CSV and every command the grid, Stats Panel, and
 * application menu run against it. Views read `snapshot()` through `useSyncExternalStore`; the
 * Tab speaks only CsvViewer contract types, so it knows nothing about AG Grid or React.
 *
 * Rules kept here so they cannot drift: one query feeds both row windows and Column Value Counts;
 * Live Stats refresh whenever that query or the data changes; every mutation bumps `revision` and
 * clears the selection; replies from a superseded query or a disposed Tab are dropped.
 */
export class CsvTab {
  private state: CsvTabState;
  private readonly listeners = new Set<() => void>();
  /** Advances when the query or the data changes; a row window from an older version is stale. */
  private queryVersion = 0;
  private statsRequest = 0;
  private disposed = false;

  constructor(
    private readonly viewer: Pick<CsvViewer, 'call' | 'capabilities'>,
    workingCsv: WorkingCsvView,
  ) {
    this.state = freshState(workingCsv);
  }

  get workingCsvId(): string {
    return this.state.workingCsv.workingCsvId;
  }

  readonly snapshot = (): CsvTabState => this.state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Reopen CSV: same Tab, new data. Query, selection, and Stats Panel start over. */
  replaceWorkingCsv(workingCsv: WorkingCsvView): void {
    this.queryVersion += 1;
    this.statsRequest += 1;
    this.set({ ...freshState(workingCsv), revision: this.state.revision + 1 });
  }

  setSearch(search: string): void {
    if (search === this.state.query.search) return;
    this.setQuery({ ...this.state.query, search });
  }

  /** The sort and filters the grid is about to request rows with. No-op when unchanged. */
  setGridQuery(sort: CsvSortDescriptor[], filters: CsvFilterDescriptor[]): void {
    const { query } = this.state;
    if (sameJson({ sort, filters }, { sort: query.sort, filters: query.filters })) return;
    this.setQuery({ ...query, sort, filters });
  }

  clearQuery(): void {
    if (!this.state.hasActiveQuery && this.state.query.search === '') return;
    this.setQuery(emptyQuery);
  }

  setSelection(rowIds: string[]): void {
    if (sameJson(rowIds, this.state.selectedRowIds)) return;
    this.set({ selectedRowIds: rowIds });
  }

  setFocusedColumn(column: string): void {
    if (column === this.state.focusedColumn) return;
    this.set({ focusedColumn: column });
  }

  /** Opening defaults the Stats Column to the focused grid column, else the first CSV column. */
  toggleStats(): void {
    const { stats, focusedColumn, workingCsv } = this.state;
    if (stats.open) {
      this.set({ stats: { ...stats, open: false } });
      return;
    }
    const names = workingCsv.columns.map((column) => column.name);
    const preferred = focusedColumn ?? stats.column;
    const column = names.includes(preferred) ? preferred : (names[0] ?? '');
    this.set({ stats: { open: true, column, result: null } });
    this.refreshStats();
  }

  setStatsColumn(column: string): void {
    if (column === this.state.stats.column) return;
    this.set({ stats: { ...this.state.stats, column } });
    this.refreshStats();
  }

  /**
   * One row window under the current query. Resolves null when the query or data moved on while
   * the request was in flight, so the caller shows nothing rather than a superseded window.
   */
  async rows(offset: number, limit: number): Promise<CsvRowWindow | null> {
    const version = this.queryVersion;
    const { query, workingCsv } = this.state;
    this.set({ queryStatus: 'querying' });
    try {
      const window = await this.viewer.call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset,
        limit,
        sort: query.sort,
        filters: query.filters,
        search: query.search.trim(),
      });
      if (this.stale(version)) return null;
      this.set({
        queryStatus: 'ready',
        filteredRowCount: window.filteredRowCount,
        totalRowCount: this.state.hasActiveQuery ? this.state.totalRowCount : window.filteredRowCount,
      });
      return window;
    } catch (error) {
      if (this.stale(version)) return null;
      this.set({ queryStatus: 'failed' });
      throw error;
    }
  }

  /** Resolves false when the edit was rejected, so the grid can restore the previous cell value. */
  editCell(rowId: string, column: string, value: string): Promise<boolean> {
    return this.mutate('Unable to edit cell.', () =>
      this.viewer.call({
        operation: 'csv.edit-cell',
        workingCsvId: this.workingCsvId,
        rowId,
        column,
        value,
      }),
    );
  }

  insertRow(placement: CsvInsertRowPlacement): Promise<boolean> {
    return this.mutate('Unable to insert row.', () =>
      this.viewer.call({
        operation: 'csv.insert-row',
        workingCsvId: this.workingCsvId,
        placement,
        rowIds: this.state.selectedRowIds,
        hasActiveQuery: this.state.hasActiveQuery,
      }),
    );
  }

  deleteSelectedRows(): Promise<boolean> {
    if (this.state.selectedRowIds.length === 0) return Promise.resolve(false);
    return this.mutate('Unable to delete selected rows.', () =>
      this.viewer.call({
        operation: 'csv.delete-rows',
        workingCsvId: this.workingCsvId,
        rowIds: this.state.selectedRowIds,
      }),
    );
  }

  undo(): Promise<boolean> {
    return this.mutate('Unable to undo edit.', () =>
      this.viewer.call({ operation: 'csv.undo', workingCsvId: this.workingCsvId }),
    );
  }

  redo(): Promise<boolean> {
    return this.mutate('Unable to redo edit.', () =>
      this.viewer.call({ operation: 'csv.redo', workingCsvId: this.workingCsvId }),
    );
  }

  /** Export CSV changes no data, so the grid keeps its rows; only the edit state moves. */
  async export(): Promise<void> {
    this.set({ editError: null, exportConfirmation: null });
    try {
      const result = await this.viewer.call({ operation: 'csv.export', workingCsvId: this.workingCsvId });
      if (this.disposed || result.status === 'cancelled') return;
      this.set({ editState: result.editState, exportConfirmation: this.viewer.capabilities.exportCsvSuccessMessage });
    } catch (error) {
      this.fail(error, 'Unable to export CSV.');
    }
  }

  dispose(): void {
    this.disposed = true;
    this.listeners.clear();
  }

  private async mutate(fallback: string, operation: () => Promise<CsvEditState>): Promise<boolean> {
    this.set({ editError: null });
    try {
      const editState = await operation();
      if (this.disposed) return true;
      this.queryVersion += 1;
      this.set({ editState, revision: this.state.revision + 1, selectedRowIds: [], exportConfirmation: null });
      this.refreshStats();
      return true;
    } catch (error) {
      this.fail(error, fallback);
      return false;
    }
  }

  private fail(cause: unknown, fallback: string): void {
    if (this.disposed) return;
    this.set({ editError: cause instanceof Error ? cause.message : fallback });
  }

  private setQuery(query: CsvTabQuery): void {
    this.queryVersion += 1;
    const hasActiveQuery = query.sort.length > 0 || query.filters.length > 0 || query.search.trim().length > 0;
    this.set({ query, hasActiveQuery });
    this.refreshStats();
  }

  private refreshStats(): void {
    if (!this.state.stats.open) return;
    const request = (this.statsRequest += 1);
    this.set({ stats: { ...this.state.stats, result: { status: 'loading' } } });
    void this.fetchStats().then(
      (counts) => this.settleStats(request, { status: 'ready', counts }),
      (error) =>
        this.settleStats(request, {
          status: 'failed',
          message: error instanceof Error ? error.message : 'Unable to calculate column value counts.',
        }),
    );
  }

  private async fetchStats(): Promise<CsvColumnValueCounts> {
    const { query, stats, workingCsv } = this.state;
    return this.viewer.call({
      operation: 'csv.get-column-value-counts',
      workingCsvId: workingCsv.workingCsvId,
      column: stats.column,
      filters: query.filters,
      search: query.search.trim(),
    });
  }

  private settleStats(request: number, result: CsvTabStatsResult): void {
    if (this.disposed || request !== this.statsRequest || !this.state.stats.open) return;
    this.set({ stats: { ...this.state.stats, result } });
  }

  private stale(version: number): boolean {
    return this.disposed || version !== this.queryVersion;
  }

  private set(patch: Partial<CsvTabState>): void {
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}

function freshState(workingCsv: WorkingCsvView): CsvTabState {
  return {
    workingCsv,
    editState: workingCsv.editState,
    editError: null,
    exportConfirmation: null,
    query: emptyQuery,
    hasActiveQuery: false,
    queryStatus: 'idle',
    filteredRowCount: workingCsv.rowCount,
    totalRowCount: workingCsv.rowCount,
    revision: 0,
    selectedRowIds: [],
    focusedColumn: null,
    stats: { open: false, column: workingCsv.columns[0]?.name ?? '', result: null },
  };
}

function sameJson<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
