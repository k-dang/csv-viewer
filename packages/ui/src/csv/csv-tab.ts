import { Effect, Fiber } from 'effect';
import type { QueryState } from './query-status-indicator';
import type {
  CsvColumn,
  CsvColumnPlacement,
  CsvColumnValueCounts,
  CsvEditState,
  CsvFilterDescriptor,
  CsvInsertRowPlacement,
  CsvRowWindow,
  CsvSchemaEditState,
  CsvSortDescriptor,
  CsvViewer,
  CsvViewExportEvent,
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
  exportOperation: { operationId: string; phase: 'preparing' | 'delivering' } | null;
  query: CsvTabQuery;
  /** True while sort, filters, or search shape the row window. Appending is blocked then. */
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
  private statsFiber: Fiber.Fiber<void> | null = null;
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
    this.stopStats();
    this.set({ ...freshState(workingCsv), exportOperation: this.state.exportOperation, revision: this.state.revision + 1 });
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
      this.stopStats();
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
  rows(offset: number, limit: number): Promise<CsvRowWindow | null> {
    return Effect.runPromise(this.loadRows(offset, limit));
  }

  private readonly loadRows = Effect.fnUntraced(function* (
    this: CsvTab,
    offset: number,
    limit: number,
  ): Effect.fn.Return<CsvRowWindow | null, unknown> {
    if (this.disposed) return null;
    const version = this.queryVersion;
    const { query, workingCsv } = this.state;
    this.set({ queryStatus: 'querying' });
    return yield* fromPromise(() => this.viewer.call({
      operation: 'csv.get-rows',
      workingCsvId: workingCsv.workingCsvId,
      offset,
      limit,
      sort: query.sort,
      filters: query.filters,
      search: query.search.trim(),
    })).pipe(Effect.matchEffect({
      onSuccess: (window) => Effect.sync(() => {
        if (this.stale(version)) return null;
        this.set({
          queryStatus: 'ready',
          filteredRowCount: window.filteredRowCount,
          totalRowCount: window.totalRowCount,
        });
        return window;
      }),
      onFailure: (cause) => Effect.gen({ self: this }, function* () {
        if (this.stale(version)) return null;
        this.set({ queryStatus: 'failed' });
        return yield* Effect.fail(cause);
      }),
    }));
  });

  /** Resolves false when the edit was rejected, so the grid can restore the previous cell value. */
  editCell(rowId: string, column: string, value: string): Promise<boolean> {
    return Effect.runPromise(this.mutate('Unable to edit cell.', () =>
      this.viewer.call({
        operation: 'csv.edit-cell',
        workingCsvId: this.workingCsvId,
        rowId,
        column,
        value,
      }),
    ));
  }

  insertRow(placement: CsvInsertRowPlacement): Promise<boolean> {
    return Effect.runPromise(this.mutate('Unable to insert row.', () =>
      this.viewer.call({
        operation: 'csv.insert-row',
        workingCsvId: this.workingCsvId,
        placement,
        rowIds: this.state.selectedRowIds,
        hasActiveQuery: this.state.hasActiveQuery,
      }),
    ));
  }

  deleteSelectedRows(): Promise<boolean> {
    if (this.state.selectedRowIds.length === 0) return Promise.resolve(false);
    return Effect.runPromise(this.mutate('Unable to delete selected rows.', () =>
      this.viewer.call({
        operation: 'csv.delete-rows',
        workingCsvId: this.workingCsvId,
        rowIds: this.state.selectedRowIds,
      }),
    ));
  }

  undo(): Promise<boolean> {
    return Effect.runPromise(this.mutate('Unable to undo edit.', () =>
      this.viewer.call({ operation: 'csv.undo', workingCsvId: this.workingCsvId }),
    ));
  }

  redo(): Promise<boolean> {
    return Effect.runPromise(this.mutate('Unable to redo edit.', () =>
      this.viewer.call({ operation: 'csv.redo', workingCsvId: this.workingCsvId }),
    ));
  }

  renameFocusedColumn(name: string): Promise<boolean> {
    const column = this.state.focusedColumn;
    if (!column) return Promise.resolve(false);
    if (name.trim() === column) return Promise.resolve(true);
    return Effect.runPromise(this.mutate('Unable to rename column.', () =>
      this.viewer.call({
        operation: 'csv.rename-column',
        workingCsvId: this.workingCsvId,
        column,
        name,
      }),
    ));
  }

  insertColumn(placement: CsvColumnPlacement): Promise<boolean> {
    const column = this.state.focusedColumn;
    if (!column) return Promise.resolve(false);
    return Effect.runPromise(this.mutate('Unable to insert column.', () =>
      this.viewer.call({
        operation: 'csv.insert-column',
        workingCsvId: this.workingCsvId,
        column,
        placement,
      }),
    ));
  }

  deleteFocusedColumn(): Promise<boolean> {
    const column = this.state.focusedColumn;
    if (!column) return Promise.resolve(false);
    return Effect.runPromise(this.mutate('Unable to delete column.', () =>
      this.viewer.call({
        operation: 'csv.delete-column',
        workingCsvId: this.workingCsvId,
        column,
      }),
    ));
  }

  reorderColumns(columns: readonly string[]): Promise<boolean> {
    const current = this.state.workingCsv.columns.map((column) => column.name);
    if (columns.length === current.length && columns.every((name, index) => name === current[index])) {
      return Promise.resolve(true);
    }
    return Effect.runPromise(this.mutate('Unable to reorder columns.', () =>
      this.viewer.call({
        operation: 'csv.reorder-columns',
        workingCsvId: this.workingCsvId,
        columns: [...columns],
      }),
    ));
  }

  /**
   * Copies the focused column under the current query to the clipboard, one value per line, nulls
   * as empty lines. No-op without a focused column; a failure is shown like an edit error.
   */
  copyFocusedColumn(): Promise<{ column: string; count: number } | undefined> {
    return Effect.runPromise(Effect.gen({ self: this }, function* () {
      const { focusedColumn, query, workingCsv } = this.state;
      if (this.disposed || !focusedColumn) return;
      this.set({ editError: null });
      const result = yield* fromPromise(() => this.viewer.call({
        operation: 'csv.get-column-values',
        workingCsvId: workingCsv.workingCsvId,
        column: focusedColumn,
        sort: query.sort,
        filters: query.filters,
        search: query.search.trim(),
      }));
      if (this.disposed) return;
      yield* fromPromise(() => navigator.clipboard.writeText(result.values.map((value) => value ?? '').join('\n')));
      if (this.disposed) return;
      return { column: focusedColumn, count: result.values.length };
    }).pipe(Effect.catch((cause) => Effect.sync(() => {
      this.fail(cause, 'Unable to copy column.');
      return undefined;
    }))));
  }

  /** Export CSV changes no data, so the grid keeps its rows; only the edit state moves. */
  export(): Promise<void> {
    return Effect.runPromise(this.withExport('delivering', 'Unable to export CSV.', () =>
      Effect.gen({ self: this }, function* () {
        const result = yield* fromPromise(() => this.viewer.call({ operation: 'csv.export', workingCsvId: this.workingCsvId }));
        if (this.disposed || result.status === 'cancelled') return;
        this.set({ editState: result.editState, exportConfirmation: this.viewer.capabilities.exportCsvSuccessMessage });
      }),
    ));
  }

  receiveExport(event: CsvViewExportEvent): void {
    if (this.state.exportOperation?.operationId === event.operationId) {
      this.set({ exportOperation: { operationId: event.operationId, phase: event.phase } });
    }
  }

  exportView(): Promise<void> {
    return Effect.runPromise(this.withExport('preparing', 'Unable to export current view.', (operationId) =>
      Effect.gen({ self: this }, function* () {
        const { query } = this.state;
        const result = yield* fromPromise(() => this.viewer.call({ operation: 'csv.export-view', workingCsvId: this.workingCsvId,
          operationId, sort: query.sort, filters: query.filters, search: query.search.trim() }));
        if (this.disposed) return;
        if (result.status === 'empty') this.set({ exportConfirmation: 'No matching rows to export' });
        else if (result.status === 'exported') this.set({ exportConfirmation:
          `${this.viewer.capabilities.exportCsvSuccessMessage} · ${result.rowCount.toLocaleString()} rows` });
      }),
    ));
  }

  cancelExport(): Promise<void> {
    return Effect.runPromise(Effect.gen({ self: this }, function* () {
      const operation = this.state.exportOperation;
      if (this.disposed || !operation || operation.phase !== 'preparing') return;
      yield* fromPromise(() => this.viewer.call({ operation: 'csv.cancel-view-export', workingCsvId: this.workingCsvId, operationId: operation.operationId }));
    }).pipe(Effect.catch((cause) => Effect.sync(() => this.fail(cause, 'Unable to cancel export.')))));
  }

  dispose(): void {
    this.disposed = true;
    this.stopStats();
    this.listeners.clear();
  }

  /** Export admission and cleanup are shared; completion preserves each export's edit semantics. */
  private readonly withExport = Effect.fnUntraced(function* (
    this: CsvTab,
    phase: 'preparing' | 'delivering',
    fallback: string,
    operation: (operationId: string) => Effect.Effect<void, unknown>,
  ) {
    if (this.disposed || this.state.exportOperation) return;
    const operationId = crypto.randomUUID();
    this.set({ editError: null, exportConfirmation: null, exportOperation: { operationId, phase } });
    yield* Effect.suspend(() => operation(operationId)).pipe(
      Effect.catch((cause) => Effect.sync(() => this.fail(cause, fallback))),
      Effect.ensuring(Effect.sync(() => {
        if (!this.disposed && this.state.exportOperation?.operationId === operationId) this.set({ exportOperation: null });
      })),
    );
  });

  private readonly mutate = Effect.fnUntraced(function* (
    this: CsvTab,
    fallback: string,
    operation: () => Promise<CsvEditState>,
  ) {
    if (this.disposed) return false;
    this.set({ editError: null });
    return yield* fromPromise(operation).pipe(Effect.match({
      onSuccess: (result) => {
        // An admitted write still resolves successfully after disposal; the grid uses this result.
        if (this.disposed) return true;
        this.queryVersion += 1;
        const columns = schemaColumns(result);
        const workingCsv = columns
          ? { ...this.state.workingCsv, columns }
          : this.state.workingCsv;
        const remapped = columns ? remapColumnNames(this.state, columns) : {};
        this.set({
          workingCsv,
          ...remapped,
          editState: toEditState(result),
          revision: this.state.revision + 1,
          selectedRowIds: [],
          exportConfirmation: null,
          queryStatus: 'querying',
        });
        this.refreshStats();
        return true;
      },
      onFailure: (cause) => {
        this.fail(cause, fallback);
        return false;
      },
    }));
  });

  private fail(cause: unknown, fallback: string): void {
    if (this.disposed) return;
    this.set({ editError: cause instanceof Error ? cause.message : fallback });
  }

  private setQuery(query: CsvTabQuery): void {
    this.queryVersion += 1;
    const hasActiveQuery = query.sort.length > 0 || query.filters.length > 0 || query.search.trim().length > 0;
    this.set({ query, hasActiveQuery, queryStatus: 'querying' });
    this.refreshStats();
  }

  private refreshStats(): void {
    this.stopStats();
    if (this.disposed || !this.state.stats.open) return;
    const { query, stats, workingCsv } = this.state;
    this.set({ stats: { ...stats, result: { status: 'loading' } } });
    this.statsFiber = Effect.runFork(fromPromise(() => this.viewer.call({
      operation: 'csv.get-column-value-counts',
      workingCsvId: workingCsv.workingCsvId,
      column: stats.column,
      filters: query.filters,
      search: query.search.trim(),
    })).pipe(Effect.matchEffect({
      onSuccess: (counts) => Effect.sync(() => this.settleStats({ status: 'ready', counts })),
      onFailure: (cause) => Effect.sync(() => this.settleStats({
        status: 'failed',
        message: cause instanceof Error ? cause.message : 'Unable to calculate column value counts.',
      })),
    })));
  }

  /** Interrupts only the renderer continuation; CsvViewer's backend request still runs. */
  private stopStats(): void {
    if (!this.statsFiber) return;
    Effect.runFork(Fiber.interrupt(this.statsFiber));
    this.statsFiber = null;
  }

  private settleStats(result: CsvTabStatsResult): void {
    if (this.disposed || !this.state.stats.open) return;
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
    exportOperation: null,
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

function toEditState(result: CsvEditState): CsvEditState {
  return {
    workingCsvId: result.workingCsvId,
    hasUnexportedChanges: result.hasUnexportedChanges,
    canUndo: result.canUndo,
    canRedo: result.canRedo,
  };
}

function schemaColumns(result: CsvEditState): CsvColumn[] | undefined {
  if (!isSchemaEditState(result)) return undefined;
  return result.columns;
}

function isSchemaEditState(result: CsvEditState): result is CsvSchemaEditState {
  return 'columns' in result && Array.isArray(result.columns);
}

function remapColumnNames(
  state: CsvTabState,
  columns: CsvColumn[],
): Pick<CsvTabState, 'focusedColumn' | 'query' | 'hasActiveQuery' | 'stats'> {
  const known = new Set(columns.map((column) => column.name));
  const renamed = renamedColumn(state.workingCsv.columns, columns);
  const remap = (name: string): string | null => {
    if (known.has(name)) return name;
    if (renamed && renamed.from === name) return renamed.to;
    return null;
  };
  const focused = state.focusedColumn === null ? null : remap(state.focusedColumn);
  const statsColumn = remap(state.stats.column) ?? columns[0]?.name ?? '';
  const query = {
    ...state.query,
    sort: state.query.sort.flatMap((descriptor) => {
      const column = remap(descriptor.column);
      return column ? [{ ...descriptor, column }] : [];
    }),
    filters: state.query.filters.flatMap((descriptor) => {
      const column = remap(descriptor.column);
      return column ? [{ ...descriptor, column }] : [];
    }),
  };
  return {
    focusedColumn: focused,
    query,
    hasActiveQuery: query.sort.length > 0 || query.filters.length > 0 || query.search.trim().length > 0,
    stats: { ...state.stats, column: statsColumn },
  };
}

function renamedColumn(
  previous: CsvColumn[],
  next: CsvColumn[],
): { from: string; to: string } | null {
  const previousNames = previous.map((column) => column.name);
  const nextNames = next.map((column) => column.name);
  const removed = previousNames.filter((name) => !nextNames.includes(name));
  const added = nextNames.filter((name) => !previousNames.includes(name));
  if (removed.length !== 1 || added.length !== 1) return null;
  return { from: removed[0], to: added[0] };
}

function sameJson<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** CsvViewer owns the Promise boundary; preserve its rejection for the caller's UI policy. */
function fromPromise<A>(operation: () => Promise<A>): Effect.Effect<A, unknown> {
  return Effect.tryPromise({ try: operation, catch: (cause) => cause });
}
