import { Cause, Effect, Exit, Fiber, FiberMap, Scope, Stream, SubscriptionRef } from 'effect';
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
  /** True from an export's admission until it settles; a second export is refused meanwhile. */
  exporting: boolean;
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
 * How long typed query text waits before it is committed. Comparison search and the value-filter
 * search share this one pause: `Stream.debounce` on a `SubscriptionRef`, not a pair of timers.
 */
export const queryDebounce = '150 millis';

export type QueryDebounce = {
  push(value: string): void;
  /** Drops a pending commit and treats `value` as already settled. */
  reset(value: string): void;
  dispose(): void;
};

/**
 * One debounced text input. The value captured when listening starts is not committed. A first
 * pull that is already a different value is kept: that edit landed before the stream subscribed.
 */
export function openQueryDebounce(initial: string, onCommit: (value: string) => void): QueryDebounce {
  const scope = Effect.runSync(Scope.make());
  const input = Effect.runSync(SubscriptionRef.make(initial));
  let fiber: Fiber.Fiber<void, unknown> | undefined;
  let open = true;

  const listen = (): void => {
    const subscribed = Effect.runSync(SubscriptionRef.get(input));
    const current = Effect.runFork(SubscriptionRef.changes(input).pipe(
      Stream.mapAccum(() => true, (first, value) => [false, first && value === subscribed ? [] : [value]]),
      Stream.debounce(queryDebounce),
      Stream.runForEach((value) => Effect.sync(() => onCommit(value))),
    ));
    fiber = current;
    Effect.runSync(Scope.addFinalizer(scope, Fiber.interrupt(current)));
  };
  listen();

  return {
    push(value: string): void {
      if (open) Effect.runSync(SubscriptionRef.set(input, value));
    },
    reset(value: string): void {
      if (!open) return;
      if (fiber) Effect.runSync(Fiber.interrupt(fiber));
      Effect.runSync(SubscriptionRef.set(input, value));
      listen();
    },
    dispose(): void {
      if (!open) return;
      open = false;
      Effect.runSync(Scope.close(scope, Exit.void));
    },
  };
}

/**
 * Client runtime for one view model: `SubscriptionRef` state for React, and a `FiberMap` of
 * in-flight reads. Starting a read under a key interrupts the previous read for that key.
 * Closing the scope interrupts every read.
 */
export class ViewRuntime<A> {
  private readonly listeners = new Set<() => void>();
  private sequence = 0;
  private closed = false;

  private constructor(
    private readonly scope: Scope.Closeable,
    private readonly state: SubscriptionRef.SubscriptionRef<A>,
    private readonly reads: FiberMap.FiberMap<string>,
  ) {}

  static open<A>(initial: A): ViewRuntime<A> {
    const scope = Effect.runSync(Scope.make());
    const state = Effect.runSync(SubscriptionRef.make(initial));
    const reads = Effect.runSync(FiberMap.make<string>().pipe(Effect.provideService(Scope.Scope, scope)));
    return new ViewRuntime(scope, state, reads);
  }

  readonly snapshot = (): A => SubscriptionRef.getUnsafe(this.state);

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  /** Replaces the state and notifies React listeners in this turn. */
  update(next: A): void {
    Effect.runSync(SubscriptionRef.set(this.state, next));
    for (const listener of this.listeners) listener();
  }

  /** A fresh key under `purpose`, so concurrent reads of that purpose do not interrupt each other. */
  nextKey(purpose: string): string {
    this.sequence += 1;
    return `${purpose}:${this.sequence}`;
  }

  fork<Value, Err>(key: string, effect: Effect.Effect<Value, Err>): Fiber.Fiber<Value, Err> {
    if (this.closed || this.reads.state._tag === 'Closed') return Effect.runFork(Effect.interrupt);
    return Effect.runSync(FiberMap.run(this.reads, key, effect));
  }

  interrupt(key: string): void {
    Effect.runSync(FiberMap.remove(this.reads, key));
  }

  /** Interrupts every in-flight read whose key starts with `prefix`. */
  interruptPrefixed(prefix: string): void {
    if (this.reads.state._tag !== 'Open') return;
    const keys: string[] = [];
    for (const [key] of this.reads) {
      if (key.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) this.interrupt(key);
  }

  /** The fiber's value, `null` when a newer read or disposal interrupted it, or the original failure. */
  join<A>(fiber: Fiber.Fiber<A, unknown>): Promise<A | null> {
    return Effect.runPromise(Fiber.await(fiber)).then((exit) => {
      if (Exit.isSuccess(exit)) return exit.value;
      if (Cause.hasInterruptsOnly(exit.cause)) return null;
      throw Cause.squash(exit.cause);
    });
  }

  dispose(): void {
    this.listeners.clear();
    if (this.closed) return;
    this.closed = true;
    Effect.runSync(Scope.close(this.scope, Exit.void));
  }
}

/**
 * One CSV Tab: the per-Tab state of a Working CSV and every command the grid, Stats Panel, and
 * application menu run against it. Views read `snapshot()` through `useSyncExternalStore`; the
 * Tab speaks only CsvViewer contract types, so it knows nothing about AG Grid or React.
 *
 * Rules kept here so they cannot drift: one query feeds both row windows and Column Value Counts;
 * Live Stats refresh whenever that query or the data changes; every mutation bumps `revision` and
 * clears the selection; a newer read interrupts the previous one, and a disposed Tab drops the reply.
 */
export class CsvTab {
  private readonly runtime: ViewRuntime<CsvTabState>;
  private disposed = false;

  constructor(
    private readonly viewer: Pick<CsvViewer, 'call' | 'capabilities'>,
    workingCsv: WorkingCsvView,
  ) {
    this.runtime = ViewRuntime.open(freshState(workingCsv));
  }

  private get state(): CsvTabState {
    return this.runtime.snapshot();
  }

  get workingCsvId(): string {
    return this.state.workingCsv.workingCsvId;
  }

  readonly snapshot = (): CsvTabState => this.runtime.snapshot();

  readonly subscribe = (listener: () => void): (() => void) => this.runtime.subscribe(listener);

  /** Reopen CSV: same Tab, new data. Query, selection, and Stats Panel start over. */
  replaceWorkingCsv(workingCsv: WorkingCsvView): void {
    this.runtime.interruptPrefixed('rows:');
    this.runtime.interrupt('stats');
    const current = this.state;
    this.runtime.update({ ...freshState(workingCsv), exporting: current.exporting, revision: current.revision + 1 });
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
      this.runtime.interrupt('stats');
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
   * the request was in flight, so the caller drops the superseded window instead of showing it.
   */
  async rows(offset: number, limit: number): Promise<CsvRowWindow | null> {
    if (this.disposed) return null;
    const { query, workingCsv } = this.state;
    this.set({ queryStatus: 'querying' });
    const effect = Effect.tryPromise({
      try: () => this.viewer.call({
        operation: 'csv.get-rows',
        workingCsvId: workingCsv.workingCsvId,
        offset,
        limit,
        sort: query.sort,
        filters: query.filters,
        search: query.search.trim(),
      }),
      catch: (cause: unknown) => cause,
    }).pipe(
      Effect.tap((window) => Effect.sync(() => {
        this.set({
          queryStatus: 'ready',
          filteredRowCount: window.filteredRowCount,
          totalRowCount: window.totalRowCount,
        });
      })),
      Effect.tapError(() => Effect.sync(() => {
        this.set({ queryStatus: 'failed' });
      })),
    );
    return this.runtime.join(this.runtime.fork(this.runtime.nextKey('rows'), effect));
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

  renameFocusedColumn(name: string): Promise<boolean> {
    const column = this.state.focusedColumn;
    if (!column) return Promise.resolve(false);
    if (name.trim() === column) return Promise.resolve(true);
    return this.mutate('Unable to rename column.', () =>
      this.viewer.call({
        operation: 'csv.rename-column',
        workingCsvId: this.workingCsvId,
        column,
        name,
      }),
    );
  }

  insertColumn(placement: CsvColumnPlacement): Promise<boolean> {
    const column = this.state.focusedColumn;
    if (!column) return Promise.resolve(false);
    return this.mutate('Unable to insert column.', () =>
      this.viewer.call({
        operation: 'csv.insert-column',
        workingCsvId: this.workingCsvId,
        column,
        placement,
      }),
    );
  }

  deleteFocusedColumn(): Promise<boolean> {
    const column = this.state.focusedColumn;
    if (!column) return Promise.resolve(false);
    return this.mutate('Unable to delete column.', () =>
      this.viewer.call({
        operation: 'csv.delete-column',
        workingCsvId: this.workingCsvId,
        column,
      }),
    );
  }

  reorderColumns(columns: readonly string[]): Promise<boolean> {
    const current = this.state.workingCsv.columns.map((column) => column.name);
    if (columns.length === current.length && columns.every((name, index) => name === current[index])) {
      return Promise.resolve(true);
    }
    return this.mutate('Unable to reorder columns.', () =>
      this.viewer.call({
        operation: 'csv.reorder-columns',
        workingCsvId: this.workingCsvId,
        columns: [...columns],
      }),
    );
  }

  /**
   * Copies the focused column under the current query to the clipboard, one value per line, nulls
   * as empty lines. No-op without a focused column; a failure is shown like an edit error.
   */
  async copyFocusedColumn(): Promise<{ column: string; count: number } | undefined> {
    const { focusedColumn, query, workingCsv } = this.state;
    if (this.disposed || !focusedColumn) return;
    this.set({ editError: null });
    try {
      const result = await this.viewer.call({
        operation: 'csv.get-column-values',
        workingCsvId: workingCsv.workingCsvId,
        column: focusedColumn,
        sort: query.sort,
        filters: query.filters,
        search: query.search.trim(),
      });
      if (this.disposed) return;
      await navigator.clipboard.writeText(result.values.map((value) => value ?? '').join('\n'));
      if (this.disposed) return;
      return { column: focusedColumn, count: result.values.length };
    } catch (error) {
      this.fail(error, 'Unable to copy column.');
    }
  }

  /** Export CSV changes no data, so the grid keeps its rows; only the edit state moves. */
  export(): Promise<void> {
    return this.withExport('Unable to export CSV.', async () => {
      const result = await this.viewer.call({ operation: 'csv.export', workingCsvId: this.workingCsvId });
      if (this.disposed || result.status === 'cancelled') return;
      this.set({ editState: result.editState, exportConfirmation: this.viewer.capabilities.exportCsvSuccessMessage });
    });
  }

  exportView(): Promise<void> {
    return this.withExport('Unable to export current view.', async () => {
      const { query } = this.state;
      const result = await this.viewer.call({ operation: 'csv.export-view', workingCsvId: this.workingCsvId,
        sort: query.sort, filters: query.filters, search: query.search.trim() });
      if (this.disposed) return;
      if (result.status === 'empty') this.set({ exportConfirmation: 'No matching rows to export' });
      else if (result.status === 'exported') this.set({ exportConfirmation:
        `${this.viewer.capabilities.exportCsvSuccessMessage} · ${result.rowCount.toLocaleString()} rows` });
    });
  }

  dispose(): void {
    this.disposed = true;
    this.runtime.dispose();
  }

  /** Export admission and cleanup are shared; completion preserves each export's edit semantics. */
  private async withExport(fallback: string, operation: () => Promise<void>): Promise<void> {
    if (this.disposed || this.state.exporting) return;
    this.set({ editError: null, exportConfirmation: null, exporting: true });
    try {
      await operation();
    } catch (error) {
      this.fail(error, fallback);
    } finally {
      if (!this.disposed) this.set({ exporting: false });
    }
  }

  private async mutate(fallback: string, operation: () => Promise<CsvEditState>): Promise<boolean> {
    if (this.disposed) return false;
    this.set({ editError: null });
    try {
      const result = await operation();
      // An admitted write still resolves successfully after disposal; the grid uses this result.
      if (this.disposed) return true;
      this.runtime.interruptPrefixed('rows:');
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
    this.runtime.interruptPrefixed('rows:');
    const hasActiveQuery = query.sort.length > 0 || query.filters.length > 0 || query.search.trim().length > 0;
    this.set({ query, hasActiveQuery, queryStatus: 'querying' });
    this.refreshStats();
  }

  private refreshStats(): void {
    this.runtime.interrupt('stats');
    if (this.disposed || !this.state.stats.open) return;
    const { query, stats } = this.state;
    this.set({ stats: { ...stats, result: { status: 'loading' } } });
    this.runtime.fork('stats', Effect.tryPromise({
      try: () => this.valueCounts(stats.column, { filters: query.filters, search: query.search }),
      catch: (cause: unknown) => cause,
    }).pipe(Effect.matchEffect({
      onSuccess: (counts) => Effect.sync(() => this.settleStats({ status: 'ready', counts })),
      onFailure: (cause) => Effect.sync(() => this.settleStats({
        status: 'failed',
        message: cause instanceof Error ? cause.message : 'Unable to calculate column value counts.',
      })),
    })));
  }

  /** Column Value Counts for one column under `scope`. Live Stats and Value Filter lists both use it. */
  valueCounts(column: string, scope: Pick<CsvTabQuery, 'filters' | 'search'>): Promise<CsvColumnValueCounts> {
    return this.viewer.call({
      operation: 'csv.get-column-value-counts',
      workingCsvId: this.workingCsvId,
      column,
      filters: scope.filters,
      search: scope.search.trim(),
    });
  }

  /**
   * Counts for the value-filter list. A newer watch interrupts the previous one, so a superseded
   * reply never calls `onResult`. The returned function interrupts this watch.
   */
  watchValueCounts(
    column: string,
    scope: Pick<CsvTabQuery, 'filters' | 'search'>,
    onResult: (result: Exclude<CsvTabStatsResult, { status: 'loading' }>) => void,
  ): () => void {
    const fiber = this.runtime.fork('valueCounts', Effect.tryPromise({
      try: () => this.valueCounts(column, scope),
      catch: (cause: unknown) => cause,
    }).pipe(Effect.matchEffect({
      onSuccess: (counts) => Effect.sync(() => onResult({ status: 'ready', counts })),
      onFailure: (cause) => Effect.sync(() => onResult({
        status: 'failed',
        message: cause instanceof Error ? cause.message : 'Unable to load column values.',
      })),
    })));
    return () => {
      Effect.runSync(Fiber.interrupt(fiber));
    };
  }

  private settleStats(result: CsvTabStatsResult): void {
    if (this.disposed || !this.state.stats.open) return;
    this.set({ stats: { ...this.state.stats, result } });
  }

  private set(patch: Partial<CsvTabState>): void {
    this.runtime.update({ ...this.state, ...patch });
  }
}

function freshState(workingCsv: WorkingCsvView): CsvTabState {
  return {
    workingCsv,
    editState: workingCsv.editState,
    editError: null,
    exportConfirmation: null,
    exporting: false,
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
